import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WeatherService } from '../weather/weather.service';
import { localDateOf } from '../common/localdate';
import { DevicesService } from './devices.service';

const TICK_MS = 60_000;

/**
 * Fires device schedules. Each schedule runs once per local day when its
 * resolved time (a clock time, or sunrise/sunset ± offset) has passed. Critical
 * devices are never actuated — DevicesService.command enforces it, and we skip
 * them here so they don't log errors every minute.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly weather: WeatherService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Minutes-since-midnight for sunrise/sunset today, from the weather forecast. */
  private sunMinutes(which: 'sunrise' | 'sunset'): number | null {
    const daily = this.weather.getWeather().daily;
    const iso = daily?.[which]?.[0];
    if (!iso) return null;
    const d = new Date(iso);
    return d.getHours() * 60 + d.getMinutes();
  }

  private async tick(): Promise<void> {
    const schedules = await this.prisma.deviceSchedule.findMany({
      where: { enabled: true },
      include: { device: true },
    });
    if (!schedules.length) return;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const today = localDateOf(now);

    for (const schedule of schedules) {
      if (schedule.lastRunDate === today) continue;
      if (schedule.device.critical) continue;

      let target: number | null = null;
      if (schedule.trigger === 'time' && schedule.timeOfDay) {
        const [h, m] = schedule.timeOfDay.split(':').map(Number);
        target = h * 60 + m;
      } else if (schedule.trigger === 'sunrise' || schedule.trigger === 'sunset') {
        const base = this.sunMinutes(schedule.trigger);
        if (base !== null) target = base + schedule.offsetMin;
      }
      if (target === null || nowMinutes < target) continue;
      // Don't fire stale schedules more than ~2h late (e.g. after a long downtime).
      if (nowMinutes - target > 120) {
        await this.mark(schedule.id, today);
        continue;
      }

      try {
        await this.devices.command(
          schedule.deviceId,
          schedule.action,
          schedule.value ?? undefined,
        );
        this.logger.log(
          `Schedule ${schedule.id}: ${schedule.device.name} → ${schedule.action} (${schedule.trigger})`,
        );
      } catch (error) {
        this.logger.warn(`Schedule ${schedule.id} failed: ${(error as Error).message}`);
      }
      await this.mark(schedule.id, today);
    }
  }

  private async mark(id: number, date: string): Promise<void> {
    await this.prisma.deviceSchedule.update({ where: { id }, data: { lastRunDate: date } });
  }
}
