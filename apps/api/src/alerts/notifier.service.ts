import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const NOTIFY_WEBHOOK_SETTING = 'notifyWebhookUrl';

/** About a year of daily summaries, and small enough for a Pi's SD card. */
export const KEEP_NOTIFICATIONS = 500;

/**
 * HTTP header values are ByteStrings — Latin-1 — and `fetch` throws "Cannot convert
 * argument to a ByteString" before the request leaves the process for anything outside
 * that range; titles here start with an emoji by design. RFC 2047 encoded-words are the
 * standard answer and ntfy decodes them. ASCII titles pass through untouched.
 */
export function headerSafe(value: string): string {
  // Printable ASCII only — the range a header value can carry literally.
  if (/^[ -~]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Pushes to a webhook from Settings or NOTIFY_WEBHOOK_URL: ntfy.sh (plain-text POST) or
 * Discord (JSON). A bare ntfy topic name expands to https://ntfy.sh/<topic>.
 */
@Injectable()
export class NotifierService {
  private readonly logger = new Logger(NotifierService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async resolveUrl(): Promise<string | null> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: NOTIFY_WEBHOOK_SETTING },
    });
    const raw = (setting?.value || process.env.NOTIFY_WEBHOOK_URL || '').trim();
    if (!raw) return null;
    if (/^https?:\/\//.test(raw)) return raw;
    // Bare topic → ntfy.sh
    return `https://ntfy.sh/${raw}`;
  }

  /** By row count, not age: a quiet month adds thirty, a failing inverter thirty in a day. */
  private async prune(): Promise<void> {
    const oldest = await this.prisma.notification.findMany({
      orderBy: { raisedAt: 'desc' },
      skip: KEEP_NOTIFICATIONS,
      select: { id: true },
    });
    if (oldest.length === 0) return;
    await this.prisma.notification.deleteMany({ where: { id: { in: oldest.map((r) => r.id) } } });
  }

  /** Record first, then deliver: a row is raised whether or not a webhook is configured. */
  async send(text: string, options: { title?: string; tags?: string } = {}): Promise<void> {
    const record = await this.prisma.notification.create({
      data: {
        raisedAt: new Date(),
        title: options.title ?? null,
        body: text,
        tags: options.tags ?? null,
      },
    });
    void this.prune().catch(() => undefined);

    const url = await this.resolveUrl();
    // Nowhere to send is not a failure: `error` stays null.
    if (!url) return;
    try {
      const isDiscord = url.includes('discord.com/api/webhooks');
      const headers: Record<string, string> = {
        'Content-Type': isDiscord ? 'application/json' : 'text/plain',
      };
      if (!isDiscord && options.title) headers['X-Title'] = headerSafe(options.title);
      if (!isDiscord && options.tags) headers['X-Tags'] = headerSafe(options.tags);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: isDiscord ? JSON.stringify({ content: `${options.title ? `**${options.title}**\n` : ''}${text}` }) : text,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await this.prisma.notification.update({
        where: { id: record.id },
        data: { deliveredAt: new Date() },
      });
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`Notification failed: ${message}`);
      // On the row, not only in the log: a long-404ing webhook is invisible otherwise.
      await this.prisma.notification
        .update({ where: { id: record.id }, data: { error: message.slice(0, 200) } })
        .catch(() => undefined);
    }
  }

  /** Newest first. The UI reads this; nothing else does. */
  async history(limit: number): Promise<
    Array<{
      id: number;
      raisedAt: string;
      title: string | null;
      body: string;
      deliveredAt: string | null;
      error: string | null;
    }>
  > {
    const rows = await this.prisma.notification.findMany({
      orderBy: { raisedAt: 'desc' },
      take: Math.max(1, Math.min(limit, KEEP_NOTIFICATIONS)),
    });
    return rows.map((row) => ({
      id: row.id,
      raisedAt: row.raisedAt.toISOString(),
      title: row.title,
      body: row.body,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      error: row.error,
    }));
  }
}
