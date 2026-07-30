import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const NOTIFY_WEBHOOK_SETTING = 'notifyWebhookUrl';

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

  async send(text: string, options: { title?: string; tags?: string } = {}): Promise<void> {
    const url = await this.resolveUrl();
    if (!url) return;
    try {
      const isDiscord = url.includes('discord.com/api/webhooks');
      const headers: Record<string, string> = {
        'Content-Type': isDiscord ? 'application/json' : 'text/plain',
      };
      if (!isDiscord && options.title) headers['X-Title'] = options.title;
      if (!isDiscord && options.tags) headers['X-Tags'] = options.tags;
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: isDiscord ? JSON.stringify({ content: `${options.title ? `**${options.title}**\n` : ''}${text}` }) : text,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      this.logger.warn(`Notification failed: ${(error as Error).message}`);
    }
  }
}
