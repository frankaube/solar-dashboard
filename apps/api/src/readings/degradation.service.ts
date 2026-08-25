import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { localDateOf } from '../common/localdate';
import { AnalyticsService } from './analytics.service';
import { ReadingsService } from './readings.service';
import { DegradationDto, assessDegradation } from './degradation';

/**
 * Records the array's learned response once a month, so that in two years there is something
 * to measure degradation against. It cannot be reconstructed later — it needs AC output
 * paired with measured irradiance at the time — so every month not written is lost. The
 * month in progress is rewritten each tick rather than appended.
 */

/** Hourly. The value moves slowly and the window it reads is measured in weeks. */
const TICK_MS = 60 * 60_000;
/** Wait before the first write, so a restart loop cannot hammer the learning query. */
const FIRST_TICK_MS = 5 * 60_000;
/**
 * Hours of chart history to ask for — deliberately tiny. The learned response is fitted over
 * its own fixed window inside the analytics service and does not widen with this; a larger
 * value only buys a longer `points` array nothing here reads.
 */
const CHART_HOURS = 1;

@Injectable()
export class DegradationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DegradationService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly readings: ReadingsService,
  ) {}

  onModuleInit(): void {
    this.first = setTimeout(() => void this.snapshot(), FIRST_TICK_MS);
    this.timer = setInterval(() => void this.snapshot(), TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  /**
   * Write this month's learned response, if there is one. Silent on a null factor: the array
   * and the weather record have not overlapped enough, and a placeholder row would later
   * read as a real month.
   */
  async snapshot(): Promise<void> {
    try {
      const analytics = await this.analytics.getProductionAnalytics(CHART_HOURS);
      const factor = analytics.wattsPerIrradiance;
      if (factor === null || !Number.isFinite(factor) || factor <= 0) return;

      const samples = analytics.learningSamples;
      const month = localDateOf(new Date()).slice(0, 7);

      /*
        Keep the best-SUPPORTED reading for the month, not the most recent. This runs hourly,
        so without the guard a month is represented by whatever was computed at its last
        tick — possibly after three overcast days, on a handful of dim samples.
      */
      const existing = await this.prisma.systemResponseSnapshot.findUnique({
        where: { month },
        select: { samples: true },
      });
      if (existing && existing.samples > samples) return;

      const config = await this.readings.getConfig();
      const data = {
        wattsPerIrradiance: factor,
        samples,
        ratedKw: config.systemRatedKw ?? null,
        recordedAt: new Date(),
      };
      await this.prisma.systemResponseSnapshot.upsert({
        where: { month },
        create: { month, ...data },
        update: data,
      });
    } catch (error) {
      // A failed snapshot is one missing month, not a reason to take the app down.
      this.logger.warn(`Could not record this month's system response: ${String(error)}`);
    }
  }

  async getDegradation(): Promise<DegradationDto> {
    const rows = await this.prisma.systemResponseSnapshot.findMany({
      orderBy: { month: 'asc' },
      select: { month: true, wattsPerIrradiance: true, samples: true },
    });
    return assessDegradation(rows);
  }
}
