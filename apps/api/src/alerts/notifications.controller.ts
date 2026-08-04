import { BadRequestException, Body, Controller, Get, Post, Put } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NOTIFY_WEBHOOK_SETTING, NotifierService } from './notifier.service';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: NotifierService,
  ) {}

  @Get()
  async get(): Promise<object> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: NOTIFY_WEBHOOK_SETTING },
    });
    return { webhook: setting?.value ?? process.env.NOTIFY_WEBHOOK_URL ?? null };
  }

  @Put()
  async put(@Body() body: { webhook?: unknown }): Promise<object> {
    const value = body.webhook === null || body.webhook === undefined ? '' : String(body.webhook).trim();
    await this.prisma.setting.upsert({
      where: { key: NOTIFY_WEBHOOK_SETTING },
      create: { key: NOTIFY_WEBHOOK_SETTING, value },
      update: { value },
    });
    return { webhook: value || null };
  }

  @Post('test')
  async test(): Promise<object> {
    await this.notifier.send('Test notification from Solar Dashboard 🔔', {
      title: 'Solar Dashboard',
      tags: 'bell',
    });
    return { sent: true };
  }
}
