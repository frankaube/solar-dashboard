import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChargerService } from '../charger/charger.service';
import { SITE_TIMEZONE, localDateOf } from '../common/localdate';
import {
  buildBuckets,
  integrateHourly,
  localDate,
  localParts,
} from './hourly-flows';
import { DailyEnergyDto, ReadingsService } from './readings.service';
import { integrateMains, selfConsumedFromMains } from './mains';
import { MeasuredShare, measuredSelfConsumptionShare } from './self-consumption-share';
import { RateEntry, rateOn, retailOf, weightedRate } from './rate-history';
import { UtilityImportService } from './utility-import.service';
import {
  FlowBucket,
  MarginalValue,
  ResolvedRate,
  RewardProgram,
  marginalValue,
  needsHourlyData,
  programRates,
  resolveProgram,
  valueProgram,
  valueProgramOverBuckets,
} from './reward-programs';

/**
 * What the energy was worth under the owner's programme. Measures the flows and hands them
 * to `reward-programs`; it knows nothing about tariffs.
 *
 * Self-consumption here is MEASURED, not modelled — EV charging overlapping production and
 * battery discharge are known, base load is not — so it is a floor, and a programme paying
 * more for self-use than export under-reports. The headline "saved" figure stays gross
 * (produced × retail); this is the breakdown under it.
 */

const MAX_SAMPLE_GAP_MS = 10 * 60_000;
const LIFETIME_DAYS = 4000; // wider than any real history — effectively "all"
const PERCENT = 100;
/** The UI polls this endpoint every 5 min; the underlying scan is the expensive part. */
const CACHE_TTL_MS = 60_000;
/**
 * Ceiling on rows read for hourly valuation. A five-minute poll is ~105,000 rows a year.
 * Most recent first, so today and this month stay exact.
 */
const MAX_HOURLY_SAMPLES = 200_000;

export interface SavingsPeriod {
  producedKwh: number;
  selfConsumedKwh: number;
  exportedKwh: number;
  /** produced × retail — optimistic ceiling; matches the Overview headline. */
  grossValue: number;
  /*
    The three fields below are net metering's own line items, kept for existing consumers.
    Under any other programme they are zero — the rule ids they look up do not exist — so
    prefer `lines`.
  */
  /** Net metering only: produced × export credit. Zero under other programmes. */
  netMeteringValue: number;
  /** Net metering only: the tax kept by using solar rather than buying it back. */
  bonusCaptured: number;
  /** What was actually kept, whatever the programme. The honest headline. */
  realizedSaved: number;
  /** Net metering only: tax payable on exported energy — a ceiling, not a loss. */
  bonusForegone: number;
  selfConsumptionPct: number;
  /**
   * True when the self-consumption figure came from the owner's estimate rather than from
   * a meter. Per period, so a derived figure can be labelled as a guess.
   */
  selfConsumptionEstimated: boolean;
  /**
   * Production whose self-consumption was measured at a meter, in kWh. Alongside
   * producedKwh it says how much of the period rests on measurement, which the one-bit flag
   * above cannot: a published usage export lags, so part-measured periods are the norm.
   */
  measuredProducedKwh: number;
  /** The chosen programme itemised. General; prefer this over the named fields. */
  lines: Array<{ id: string; label: string; amount: number; realised: boolean; note?: string }>;
  programName: string;
}

export interface SavingsDto {
  rates: {
    retailPerKwh: number;
    /** The sales tax setting. A config value, not a net-metering artefact. */
    hstRate: number;
    /** What the chosen programme pays per kWh, and for which flow. */
    perKwh: ResolvedRate[];
    /** What one more kWh is worth used at home versus exported, under this programme. */
    marginal: MarginalValue;
  };
  today: SavingsPeriod;
  month: SavingsPeriod;
  year: SavingsPeriod;
  lifetime: SavingsPeriod;
  measured: { evSolarKwhLifetime: number; batteryDischargeKwhLifetime: number };
  systemCostCad: number | null;
  paybackProgressPct: number | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

@Injectable()
export class SavingsService {
  private cache: { at: number; value: SavingsDto } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly readings: ReadingsService,
    private readonly charger: ChargerService,
    private readonly utility: UtilityImportService,
  ) {}

  /**
   * EV energy that overlapped solar production, bucketed by the site-local date the charge
   * started on — so it sums over the same calendar periods the production figures use.
   */
  private async evSolarKwhByDate(): Promise<Map<string, number>> {
    const { sessions } = await this.charger.getSessions(LIFETIME_DAYS);
    const byDate = new Map<string, number>();
    for (const session of sessions) {
      const date = localDateOf(new Date(session.startedAt));
      byDate.set(date, (byDate.get(date) ?? 0) + session.solarWh / 1000);
    }
    return byDate;
  }

  /**
   * Energy exported past the service entrance (kWh), by site-local date.
   *
   * NULL, not an empty map, when no device claims the `mains` role — an empty map means a
   * clamp measured no export, which would make every kWh look self-consumed.
   *
   * Channel 0 only. A multi-channel meter writes the whole-device figure there and its
   * individual legs to 1..n, so summing every row double-counts a split-phase service.
   */
  private async mainsExportedKwhByDate(): Promise<Map<string, number> | null> {
    /*
      The utility's own meter first: same boundary, but it is what the bill is calculated
      from and reaches back to day one. Days it recorded no export while the array produced
      are absent from the map rather than zero, so they fall through to the estimate.
    */
    const fromUtility = await this.utility.exportedKwhByDate();
    if (fromUtility.size > 0) return fromUtility;

    const meter = await this.prisma.device.findFirst({
      where: { role: 'mains', enabled: true },
      select: { id: true },
    });
    if (!meter) return null;

    const rows = await this.prisma.deviceReading.findMany({
      where: { deviceId: meter.id, channel: 0, powerW: { not: null } },
      orderBy: { takenAt: 'asc' },
      select: { takenAt: true, powerW: true },
    });
    const totals = integrateMains(
      rows.map((row) => ({ takenAt: row.takenAt, powerW: row.powerW as number })),
      localDateOf,
    );
    const byDate = new Map<string, number>();
    for (const [date, { exportedWh }] of totals) byDate.set(date, exportedWh / 1000);
    return byDate;
  }

  /** Battery discharge (kWh) bucketed by site-local date, integrated from the power series. */
  private async batteryDischargeKwhByDate(): Promise<Map<string, number>> {
    const rows = await this.prisma.batteryReading.findMany({
      orderBy: { takenAt: 'asc' },
      select: { takenAt: true, powerW: true },
    });
    const byDate = new Map<string, number>();
    for (let i = 0; i < rows.length - 1; i++) {
      const w = rows[i].powerW;
      if (w >= 0) continue;
      const dtHours =
        Math.min(rows[i + 1].takenAt.getTime() - rows[i].takenAt.getTime(), MAX_SAMPLE_GAP_MS) /
        3_600_000;
      const date = localDateOf(rows[i].takenAt);
      byDate.set(date, (byDate.get(date) ?? 0) + (-w * dtHours) / 1000);
    }
    return byDate;
  }

  /**
   * Value a period through the reward engine. The named DTO fields below are the engine's
   * own lines looked up by rule id; savings-engine-parity.spec.ts pins them against the
   * previous hand-rolled net-metering arithmetic across eight rate and tax combinations.
   */
  private buildPeriod(
    producedWh: number,
    selfConsumedRaw: number,
    estimated: boolean,
    retail: number,
    program: RewardProgram,
    /*
      Hourly flows for this period. Passed rather than fetched so one pass over the readings
      serves all four periods. Absent for programmes with no time-limited rules.
    */
    buckets?: FlowBucket[],
    /** Production whose self-consumption came from a meter rather than an assumption. */
    measuredProducedKwh = 0,
  ): SavingsPeriod {
    const producedKwh = producedWh / 1000;
    const selfConsumedKwh = Math.min(producedKwh, Math.max(0, selfConsumedRaw));
    const exportedKwh = Math.max(0, producedKwh - selfConsumedKwh);
    const valued = buckets
      ? valueProgramOverBuckets(program, buckets, retail)
      : valueProgram(program, { producedKwh, selfConsumedKwh, exportedKwh }, retail);
    const line = (id: string): number => valued.lines.find((l) => l.ruleId === id)?.amount ?? 0;
    return {
      producedKwh: round1(producedKwh),
      measuredProducedKwh: round1(Math.min(measuredProducedKwh, producedKwh)),
      selfConsumedKwh: round1(selfConsumedKwh),
      exportedKwh: round1(exportedKwh),
      grossValue: producedKwh * retail,
      netMeteringValue: line('export-credit'),
      bonusCaptured: line('tax-kept'),
      realizedSaved: valued.realised,
      bonusForegone: line('tax-foregone'),
      selfConsumptionPct: producedKwh > 0 ? Math.round((selfConsumedKwh / producedKwh) * PERCENT) : 0,
      selfConsumptionEstimated: estimated,
      // The itemised breakdown, carried alongside the net-metering-specific named fields.
      lines: valued.lines.map((l) => ({
        id: l.ruleId,
        label: l.label,
        amount: l.amount,
        realised: l.realised,
        note: l.note,
        })),
      programName: program.name,
    };
  }

  /**
   * Hourly production and self-consumption, integrated from the stored samples.
   *
   * Only called for programmes with time-limited rules — see the guard in getSavings.
   * Bounded by MAX_HOURLY_SAMPLES; the most recent rows keep today and this month exact.
   *
   * Battery discharge is the only self-consumption with a power series. EV charging is
   * recorded per session rather than sampled, so it is folded in at the hour the session
   * started — sessions are short enough for that to be a fair attribution.
   */
  private async hourlyBuckets(): Promise<{
    production: Map<string, number>;
    selfConsumption: Map<string, number>;
  }> {
    const timeZone = SITE_TIMEZONE;
    const [dtuRows, batteryRows, { sessions }] = await Promise.all([
      this.prisma.dtuReading.findMany({
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, totalPower: true },
        take: MAX_HOURLY_SAMPLES,
      }),
      this.prisma.batteryReading.findMany({
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, powerW: true },
        take: MAX_HOURLY_SAMPLES,
      }),
      this.charger.getSessions(LIFETIME_DAYS),
    ]);

    const production = integrateHourly(
      dtuRows.map((r) => ({ takenAt: r.takenAt, watts: r.totalPower })),
      timeZone,
    );
    const selfConsumption = integrateHourly(
      batteryRows.map((r) => ({ takenAt: r.takenAt, watts: r.powerW })),
      timeZone,
      (w) => -w,
    );
    for (const session of sessions) {
      const at = new Date(session.startedAt);
      const parts = localParts(at, timeZone);
      const key = `${localDate(at, timeZone)}|${parts.month}|${parts.weekday}|${parts.hour}`;
      selfConsumption.set(key, (selfConsumption.get(key) ?? 0) + session.solarWh / 1000);
    }
    return { production, selfConsumption };
  }

  /**
   * Drop the cached figures. Must be called after any tariff, price or tax-rate change,
   * or the Savings page shows the previous programme's numbers for up to CACHE_TTL_MS.
   */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * What the meter says this house's self-consumption share actually is. Read by Settings
   * so the owner can compare it with the typed figure. Recomputed rather than taken from
   * the savings cache, which would serve a stale percentage next to the adopt toggle.
   */
  async selfConsumptionEstimate(): Promise<MeasuredShare & { enabled: boolean; configuredPct: number | null }> {
    const [config, mainsByDate, dailyProduction] = await Promise.all([
      this.readings.getConfig(),
      this.mainsExportedKwhByDate(),
      this.readings.getDailyEnergy(LIFETIME_DAYS),
    ]);
    const share = mainsByDate
      ? measuredSelfConsumptionShare(
          dailyProduction
            .filter((row) => row.energyWh > 0 && mainsByDate.has(row.date))
            .map((row) => ({
              date: row.date,
              producedKwh: row.energyWh / 1000,
              exportedKwh: mainsByDate.get(row.date) ?? 0,
            })),
        )
      : {
          pct: null,
          days: 0,
          producedKwh: 0,
          selfConsumedKwh: 0,
          reason: 'No meter data yet — import a usage export, or fit a clamp on the mains.',
        };
    return {
      ...share,
      enabled: config.selfConsumptionAuto,
      configuredPct: config.selfConsumptionPct,
    };
  }

  async getSavings(): Promise<SavingsDto> {
    const cached = this.cache;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const [stats, config] = await Promise.all([
      this.readings.getEnergyStats(),
      this.readings.getConfig(),
    ]);
    /*
      The configured price, read as tax-INCLUSIVE. Every rule downstream is expressed
      against that: an exported kWh is worth retail/(1+tax), a self-consumed one the whole
      retail price. Utility bills print the pre-tax rate, so `priceIncludesTax` records
      which of the two the owner typed.
    */
    const retail = config.priceIncludesTax === false
      ? config.electricityPricePerKwh * (1 + hstOf(config.hstRate))
      : config.electricityPricePerKwh;
    const hstRate = hstOf(config.hstRate);
    /*
      One programme resolved per request, reused for all four periods. An install that has
      never set the setting resolves to net metering.
    */
    const program = resolveProgram(config.rewardProgramId, {
      taxRate: hstRate,
      retailPerKwh: retail,
    });

    /*
      Hourly resolution only when the programme needs it: a flat tariff is answerable from
      period totals, and `valueProgram` refuses time-limited rules rather than pricing a
      peak rate against a daily average.
    */
    const hourly = program.rules.some(needsHourlyData) ? await this.hourlyBuckets() : null;

    // Self-consumption must be summed over the SAME calendar buckets as production. Rolling
    // windows divided by calendar-to-date production let yesterday evening's charging count
    // toward "today", which buildPeriod's clamp then hides as a plausible 100%.
    const [evByDate, battByDate, mainsByDate, dailyProduction, rateEntries] = await Promise.all([
      this.evSolarKwhByDate(),
      this.batteryDischargeKwhByDate(),
      this.mainsExportedKwhByDate(),
      // Per-day production, so a mains reading can be checked against the days it must
      // cover rather than assumed to reach back as far as the totals do.
      this.readings.getDailyEnergy(LIFETIME_DAYS),
      // Recorded rate changes, oldest first. Empty until somebody enters one.
      this.prisma.rateEntry.findMany({ orderBy: { effectiveFrom: 'asc' } }),
    ]);
    const today = localDateOf(new Date());
    const monthPrefix = today.slice(0, 7);
    const yearPrefix = today.slice(0, 4);
    const sum = (m: Map<string, number>, keep: (date: string) => boolean): number => {
      let total = 0;
      for (const [date, value] of m) if (keep(date)) total += value;
      return total;
    };
    const measuredSelfConsumed = (keep: (date: string) => boolean): number =>
      sum(evByDate, keep) + sum(battByDate, keep);
    /*
      The share applied to days no meter covered, used as a FLOOR: only EV and battery
      diversion is measurable without a meter, so the measurement is a hard lower bound and
      the estimate is not — take whichever is larger. Typed in Settings unless
      `selfConsumptionAuto` is set, which derives it from the covered days instead.
    */
    const measuredShare = mainsByDate
      ? measuredSelfConsumptionShare(
          dailyProduction
            .filter((row) => row.energyWh > 0 && mainsByDate.has(row.date))
            .map((row) => ({
              date: row.date,
              producedKwh: row.energyWh / 1000,
              exportedKwh: mainsByDate.get(row.date) ?? 0,
            })),
        )
      : null;
    const autoShare = config.selfConsumptionAuto && measuredShare?.pct !== null && measuredShare !== null
      ? measuredShare.pct
      : null;
    const sharePct = autoShare ?? config.selfConsumptionPct ?? 0;
    const assumedShare = sharePct ? sharePct / PERCENT : 0;

    /**
     * Split a period into the days a meter can speak for and the days it cannot. Where a
     * mains measurement exists it replaces the estimate outright.
     *
     * Per DAY, not per period: a clamp fitted in March says nothing about last year, and
     * subtracting its exports from a lifetime total would report every pre-clamp kWh as
     * used at home — but an all-or-nothing rule discards everything, since a published
     * usage export lags and no period is ever fully covered.
     */
    const splitByCoverage = (
      keep: (date: string) => boolean,
    ): { coveredKwh: number; exportedKwh: number; uncoveredKwh: number } => {
      let coveredKwh = 0;
      let exportedKwh = 0;
      let uncoveredKwh = 0;
      for (const row of dailyProduction) {
        if (!keep(row.date) || row.energyWh <= 0) continue;
        const exported = mainsByDate?.get(row.date);
        if (exported === undefined) uncoveredKwh += row.energyWh / 1000;
        else {
          coveredKwh += row.energyWh / 1000;
          exportedKwh += exported;
        }
      }
      return { coveredKwh, exportedKwh, uncoveredKwh };
    };

    /** EV and battery on days no meter covered — the floor for the estimated remainder. */
    const measuredOnUncovered = (keep: (date: string) => boolean): number => {
      const uncovered = (date: string): boolean => keep(date) && !mainsByDate?.has(date);
      return sum(evByDate, uncovered) + sum(battByDate, uncovered);
    };

    const selfConsumed = (keep: (date: string) => boolean, producedWh: number): number => {
      const { coveredKwh, exportedKwh, uncoveredKwh } = splitByCoverage(keep);
      if (mainsByDate === null || coveredKwh === 0) {
        return Math.max(measuredSelfConsumed(keep), (producedWh / 1000) * assumedShare);
      }
      const measured = selfConsumedFromMains(coveredKwh, exportedKwh);
      /*
        The remainder uses the period total, not the summed daily figures, so a day the
        rollup has not caught up on is still valued rather than dropped between the two.
      */
      const remainderKwh = Math.max(uncoveredKwh, producedWh / 1000 - coveredKwh);
      const estimatedPart = Math.max(measuredOnUncovered(keep), remainderKwh * assumedShare);
      return measured + Math.max(0, estimatedPart);
    };

    /** Production whose self-consumption came from a meter rather than an assumption. */
    const measuredProducedKwh = (keep: (date: string) => boolean): number =>
      mainsByDate === null ? 0 : splitByCoverage(keep).coveredKwh;

    /** True when any part of the period leaned on the owner's estimate. */
    const leanedOnEstimate = (keep: (date: string) => boolean, producedWh: number): boolean => {
      const { coveredKwh } = splitByCoverage(keep);
      const remainderKwh = producedWh / 1000 - coveredKwh;
      if (remainderKwh <= 0.01) return false;
      return remainderKwh * assumedShare > measuredOnUncovered(keep);
    };

    /*
      One `keep` predicate per period, used for BOTH the self-consumption totals and
      the hourly buckets, so the two cannot disagree about what "this month" means.
    */
    const windows: Array<[number, (date: string) => boolean]> = [
      [stats.todayWh, (d) => d === today],
      [stats.monthWh, (d) => d.startsWith(monthPrefix)],
      [stats.yearWh, (d) => d.startsWith(yearPrefix)],
      [stats.lifetimeWh, () => true],
    ];
    /*
      Each period priced at the rate in effect across ITS days, so a rate change does not
      retroactively move historical totals. Weighted by production, not day count: a rate in
      effect through December carried less energy than one through June. Falls back to the
      configured price when no rate history has been recorded.
    */
    const fallbackRate: RateEntry = {
      effectiveFrom: '1970-01-01',
      pricePerKwh: config.electricityPricePerKwh,
      hstRate,
      priceIncludesTax: config.priceIncludesTax !== false,
    };
    const rateFor = (keep: (date: string) => boolean) =>
      weightedRate(rateEntries, dailyProduction.filter((row) => keep(row.date)), fallbackRate);

    const [todayP, month, year, lifetime] = windows.map(([wh, keep]) =>
      this.buildPeriod(
        wh,
        selfConsumed(keep, wh),
        // Estimated when ANY part of the period leaned on the assumption.
        leanedOnEstimate(keep, wh),
        rateFor(keep).retail,
        program,
        hourly ? buildBuckets(hourly.production, hourly.selfConsumption, keep) : undefined,
        measuredProducedKwh(keep),
      ),
    );

    /*
      The rate in effect TODAY, for the figures that are about now. `marginal` answers "what
      is one more kWh worth"; the periods above answer "what was it worth" and are priced
      historically.
    */
    const currentRate = rateOn(rateEntries, today) ?? fallbackRate;
    const currentRetail = retailOf(currentRate);

    const value: SavingsDto = {
      rates: {
        retailPerKwh: currentRetail,
        hstRate: currentRate.hstRate,
        perKwh: programRates(program, currentRetail),
        marginal: marginalValue(program, currentRetail),
      },
      today: todayP,
      month,
      year,
      lifetime,
      measured: {
        evSolarKwhLifetime: round1(sum(evByDate, () => true)),
        batteryDischargeKwhLifetime: round1(sum(battByDate, () => true)),
      },
      systemCostCad: stats.systemCostCad,
      paybackProgressPct: stats.systemCostCad
        ? (lifetime.grossValue / stats.systemCostCad) * PERCENT
        : null,
    };
    this.cache = { at: Date.now(), value };
    return value;
  }
}

/**
 * Guard a tax rate read from storage: a stored -1 makes the pre-tax divisor Infinity and
 * every money field NaN, which serializes to null and renders blank rather than as an error.
 */
function hstOf(raw: number): number {
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0;
}
