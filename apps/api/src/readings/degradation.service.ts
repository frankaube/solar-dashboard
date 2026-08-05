import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { localDateOf } from '../common/localdate';
import { AnalyticsService } from './analytics.service';
import { ReadingsService } from './readings.service';
import { DegradationDto, assessDegradation } from './degradation';

/**
 * Records the array's learned response once a month, so that in two years there is
 * something to measure degradation against.
 *
 * This ships years before it can answer the question it exists for, and that is the point.
 * The figure cannot be reconstructed later: deriving it needs AC output paired with
 * measured irradiance at the time, and nobody keeps that from before they thought to
 * start. Every month not written here is permanently absent from a measurement that only
 * becomes more valuable with age.
 *
 * The month in progress is rewritten each tick rather than appended, so August holds one
 * row that improves as August fills, not thirty rows of partial answers.
 */

/** Hourly. The value moves slowly and the window it reads is measured in weeks. */
const TICK_MS = 60 * 60_000;
/** Wait before the first write, so a restart loop cannot hammer the learning query. */
const FIRST_TICK_MS = 5 * 60_000;
/**
 * Hours of chart history to ask for — deliberately tiny.
 *
 * The learned response is fitted over its own fixed window inside the analytics service
 * and does not widen with this argument; all a larger number buys is a longer `points`
 * array that nothing here reads. Asking for one hour keeps an hourly background job from
 * pulling a month of readings off a Raspberry Pi to compute a number it would have got
 * either way.
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
   * Write this month's learned response, if there is one.
   *
   * Silent when the response has not been learned — a null factor means the array and the
   * weather record have not overlapped enough to divide one by the other, and writing a
   * placeholder would put a row in the series that later reads as a real month.
   */
  async snapshot(): Promise<void> {
    try {
      const analytics = await this.analytics.getProductionAnalytics(CHART_HOURS);
      const factor = analytics.wattsPerIrradiance;
      if (factor === null || !Number.isFinite(factor) || factor <= 0) return;

      const samples = analytics.learningSamples;
      const month = localDateOf(new Date()).slice(0, 7);

      /*
        Keep the best-supported reading for the month, not the most recent one.

        This runs hourly, so without the guard the value filed under December is whichever
        one happened to be computed at 23:00 on the 31st — quite possibly after three
        overcast days, when the median rests on a handful of dim samples. Taking the
        best-sampled tick instead means each month is represented by its clearest look at
        the array, which is the comparison the whole series is for.
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
