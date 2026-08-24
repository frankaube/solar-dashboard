import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const NOTIFY_WEBHOOK_SETTING = 'notifyWebhookUrl';

/**
 * How many notifications to keep.
 *
 * Enough that the daily summary is readable for most of a year, and small enough that the
 * table never becomes something anybody has to think about on a Pi's SD card.
 */
export const KEEP_NOTIFICATIONS = 500;

/**
 * A header value fetch will actually accept.
 *
 * HTTP header values are ByteStrings — Latin-1 — and `fetch` throws
 * "Cannot convert argument to a ByteString" before the request leaves the process when one
 * holds anything outside it. The titles here start with an emoji by design ("☀️ Solar day
 * wrap"), so four notifications in eighteen on this install were composed, logged, and never
 * sent, with the failure visible only in a column nobody reads.
 *
 * RFC 2047 encoded-words are the standard answer and ntfy decodes them, so the emoji
 * survives to the phone rather than being stripped to make the transport happy. ASCII titles
 * are passed through untouched, because an encoded word is unreadable to anything that does
 * not decode it and most titles never need it.
 */
export function headerSafe(value: string): string {
  // Printable ASCII only — the range a header value can carry literally.
  if (/^[ -~]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Pushes messages to a webhook configured in Settings (or NOTIFY_WEBHOOK_URL).
 * Works out of the box with ntfy.sh (plain-text POST) and Discord webhooks (JSON).
 * A bare ntfy topic name is expanded to https://ntfy.sh/<topic>.
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

  /**
   * Keep the log to the most recent `KEEP_NOTIFICATIONS`.
   *
   * Deleting by row count rather than by age, because the rate these arrive at is not
   * constant — a quiet month adds thirty and a failing inverter adds thirty in a day — so
   * a 90-day window is either far too much history or far too little depending on which
   * month you ask. A fixed count always covers the same amount of *reading*.
   */
  private async prune(): Promise<void> {
    const oldest = await this.prisma.notification.findMany({
      orderBy: { raisedAt: 'desc' },
      skip: KEEP_NOTIFICATIONS,
      select: { id: true },
    });
    if (oldest.length === 0) return;
    await this.prisma.notification.deleteMany({ where: { id: { in: oldest.map((r) => r.id) } } });
  }

  /**
   * Raise a notification: record it, then try to deliver it.
   *
   * In that order, and that is the whole change. This used to resolve a webhook and return
   * early when there was none — so on a default install, with no ntfy topic and no Discord
   * URL, every message was composed and dropped. The sunset daily summary appears nowhere
   * else in the app, so its entire existence was a push to a phone nobody had configured.
   *
   * A row means "the app had something to tell you", which is true whether or not anything
   * was listening. Whether it got out is a separate column.
   */
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
    // Nowhere to send it is not a failure — `error` stays null, and the log is the delivery.
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
      /*
        Recorded against the row rather than only in a log nobody reads. A webhook that
        has been returning 404 for a fortnight is invisible otherwise — the alerts all
        look raised, the phone is simply silent, and there is nothing to connect the two.
      */
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
