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
 * What the energy was worth, under whichever programme the owner picked.
 *
 * This measures the flows and hands them to `reward-programs`; it no longer knows what
 * a tariff is. It used to implement one utility’s net metering directly — 1:1 export with
 * sales tax on buyback — which was right for one province and wrong everywhere else.
 *
 * What it still owns, and what makes the numbers conservative: self-consumption is
 * MEASURED, not modelled. EV charging that overlapped production and battery discharge
 * are both exactly known; the base load that solar quietly covers is invisible without
 * a whole-home meter. So self-consumption here is a floor, and any programme that pays
 * more for self-use than for export will under-report rather than over-report.
 *
 * The headline "saved" figure stays gross (produced × retail). This supplies the
 * honest breakdown the Savings page shows underneath it.
 */

const MAX_SAMPLE_GAP_MS = 10 * 60_000;
const LIFETIME_DAYS = 4000; // wider than any real history — effectively "all"
const PERCENT = 100;
/** The UI polls this endpoint every 5 min; the underlying scan is the expensive part. */
const CACHE_TTL_MS = 60_000;
/**
 * Ceiling on rows read for hourly valuation.
 *
 * A five-minute poll is about 105,000 rows a year. Reading every one to price a
 * time-of-use tariff would make this the slowest endpoint in the app on an install
 * that has been running for a while. Most recent first, so today and this month —
 * where the number is actually looked at — stay exact.
 */
const MAX_HOURLY_SAMPLES = 200_000;

export interface SavingsPeriod {
  producedKwh: number;
  selfConsumedKwh: number;
  exportedKwh: number;
  /** produced × retail — optimistic ceiling; matches the Overview headline. */
  grossValue: number;
  /*
    The three fields below are net metering's own line items, kept so existing
    consumers do not break. Under any other programme they are zero — the rule ids
    they look up simply do not exist — so read `lines` instead. They go once nothing
    outside this repo reads them.
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
   * True when the self-consumption figure came from the owner's estimate rather than
   * from a meter.
   *
   * Carried per period because it decides how much weight the numbers below it can bear.
   * An estimate is worth far more than the 1% a partial meter reports, but a figure
   * derived from one must say so — otherwise the app presents a guess and a measurement
   * in the same typeface and nobody can tell which is which later.
   */
  selfConsumptionEstimated: boolean;
  /** The chosen programme itemised. General; prefer this over the named fields. */
  lines: Array<{ id: string; label: string; amount: number; realised: boolean; note?: string }>;
  programName: string;
}

export interface SavingsDto {
  rates: {
    retailPerKwh: number;
    /** The sales tax setting. A config value, not a net-metering artefact. */
    hstRate: number;
    /**
     * What the chosen programme pays per kWh, and for which flow.
     *
     * Replaces `exportCreditPerKwh` and `premiumPerKwh`, which were net metering's
     * internals published as though they were properties of solar. A feed-in tariff
     * has neither; a no-export arrangement has neither and nothing in their place.
     */
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
  ) {}

  /**
   * EV energy that overlapped solar production, bucketed by the site-local date the charge
   * started on — so it can be summed over the same calendar periods the production figures
   * use. One pass over history; previously this ran four times on overlapping windows.
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
   * Null — not an empty map — when no device claims the `mains` role. The two are different
   * answers: an empty map means a clamp is installed and measured no export, which would
   * make every kWh look self-consumed. "Nobody has told us where the mains is" must fall
   * back to the estimate instead.
   *
   * Channel 0 only. A multi-channel meter writes the whole-device figure there and its
   * individual legs to 1..n, so summing every row would count a split-phase service twice.
   */
  private async mainsExportedKwhByDate(): Promise<Map<string, number> | null> {
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
   * Value a period through the reward engine rather than by hand.
   *
   * The arithmetic that used to live here was correct, but it was correct only for New
   * Brunswick — the tariff was the shape of the code rather than data it consumed.
   * Routing through `valueProgram` means changing programme changes the answer, which
   * is the difference between the general engine being a claim and being a feature.
   *
   * The DTO is unchanged and the numbers are unchanged: savings-engine-parity.spec.ts
   * pins the two against each other across eight rate and tax combinations. The named
   * fields below are the engine's own lines, looked up by rule id.
   */
  private buildPeriod(
    producedWh: number,
    selfConsumedRaw: number,
    estimated: boolean,
    retail: number,
    program: RewardProgram,
    /*
      Hourly flows for this period, when the programme needs them.

      Passed rather than fetched so one pass over the readings serves all four periods.
      Absent for programmes with no time-limited rules, which is most of them — there
      is no reason to read a year of samples to answer a flat tariff.
    */
    buckets?: FlowBucket[],
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
      selfConsumedKwh: round1(selfConsumedKwh),
      exportedKwh: round1(exportedKwh),
      grossValue: producedKwh * retail,
      netMeteringValue: line('export-credit'),
      bonusCaptured: line('tax-kept'),
      realizedSaved: valued.realised,
      bonusForegone: line('tax-foregone'),
      selfConsumptionPct: producedKwh > 0 ? Math.round((selfConsumedKwh / producedKwh) * PERCENT) : 0,
      selfConsumptionEstimated: estimated,
      /*
        The itemised breakdown, carried alongside the named fields rather than
        replacing them. The named ones are net-metering-specific — `bonusCaptured`
        means nothing under a feed-in tariff — so the UI needs somewhere general to
        move to before they can go.
      */
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
   * Bounded by MAX_HOURLY_SAMPLES because the row count grows with the poll interval
   * and the age of the install: a five-minute poll is 105k rows a year, and an
   * unbounded scan here would eventually make the Savings page the slowest thing in
   * the app. Taking the most recent rows keeps today and this month exact, which is
   * where the number is looked at.
   *
   * Battery discharge is the only self-consumption with a power series. EV charging is
   * recorded per session rather than sampled, so it is folded in at the hour a session
   * started — sessions are short enough that this is a fair attribution and the
   * alternative is dropping it entirely.
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
   * Drop the cached figures, so the next read reflects a settings change.
   *
   * The cache exists because the underlying scan is expensive and the UI polls every
   * five minutes. It also meant that changing the tariff — or the price, or the tax
   * rate — left the Savings page showing the previous programme's numbers for up to a
   * minute, immediately after Settings said "Saved". A stale money figure that appears
   * to ignore what you just told it is worse than a slow one.
   */
  invalidate(): void {
    this.cache = null;
  }

  async getSavings(): Promise<SavingsDto> {
    const cached = this.cache;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const [stats, config] = await Promise.all([
      this.readings.getEnergyStats(),
      this.readings.getConfig(),
    ]);
    /*
      The configured price, read as tax-INCLUSIVE — what a kWh actually costs you at the
      till. Every rule downstream is expressed against that: an exported kWh is worth
      retail/(1+tax) and a self-consumed one the whole retail price.

      Utility bills print the pre-tax energy rate, so that is the number people copy in,
      and this install did exactly that — 15.39 c entered where 17.70 c was meant, which
      understated every dollar figure in the app by the tax. `priceIncludesTax` lets an
      owner say which one they typed instead of leaving it to be guessed.
    */
    const retail = config.priceIncludesTax === false
      ? config.electricityPricePerKwh * (1 + hstOf(config.hstRate))
      : config.electricityPricePerKwh;
    // Guard the value read from storage: a stored rate of -1 would make the pre-tax
    // divisor Infinity and every money field NaN, which serializes to null and
    // renders blank.
    const hstRate = hstOf(config.hstRate);
    /*
      One programme resolved per request, then reused for all four periods.

      Chosen in Settings and stored as a plain setting row, so an install that has
      never touched it resolves to net metering — exactly what this file did when the
      tariff was hardcoded, which is what makes the change invisible to existing users.
    */
    const program = resolveProgram(config.rewardProgramId, {
      taxRate: hstRate,
      retailPerKwh: retail,
    });

    /*
      Hourly resolution, only when the programme actually needs it.

      A flat tariff is answerable from period totals, so reading a year of five-minute
      samples to value one would be pure cost. A time-of-use tariff is not answerable
      that way at all — `valueProgram` refuses those rules rather than pricing a peak
      rate against a daily average — so for those we pay for the scan.
    */
    const hourly = program.rules.some(needsHourlyData) ? await this.hourlyBuckets() : null;

    // Self-consumption must be summed over the SAME calendar buckets as production.
    // Previously these were rolling windows (last 24 h / 31 d / 365 d) divided by
    // calendar-to-date production, so e.g. yesterday evening's charging counted toward
    // "today" — and buildPeriod's clamp then reported a fake "100% self-consumed, $0
    // foregone" instead of an obvious error.
    const [evByDate, battByDate, mainsByDate, dailyProduction] = await Promise.all([
      this.evSolarKwhByDate(),
      this.batteryDischargeKwhByDate(),
      this.mainsExportedKwhByDate(),
      // Per-day production, so a mains reading can be checked against the days it must
      // cover rather than assumed to reach back as far as the totals do.
      this.readings.getDailyEnergy(LIFETIME_DAYS),
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
      An assumption, applied as a FLOOR rather than a replacement.

      Without a meter on the service entrance, only solar diverted to an EV or a battery is
      measurable — the fridge, the heat pumps and the water heater are invisible, so
      measured self-consumption reads far too low and nearly every kWh gets valued at the
      export rate. Where the owner has told us what share their house really uses directly,
      take whichever is larger: the measurement is a hard lower bound, the estimate is not.
    */
    const assumedShare = config.selfConsumptionPct ? config.selfConsumptionPct / PERCENT : 0;

    /*
      A mains clamp replaces all of the above rather than joining it.

      What the house used directly is what the array made minus what actually left the
      property, and the service entrance measures the second term outright — no appliance
      has to be identified, metered, or even known about. Where that measurement exists it
      is not one more lower bound to be maxed against a typed-in percentage; it is the
      answer, and mixing an estimate into it could only make it worse.

      But only where it covers the WHOLE period, which is the part that is easy to get
      wrong. A clamp fitted in March has nothing to say about last year, and subtracting
      its exports from a lifetime total would report every pre-clamp kWh as used at home —
      turning the app's most cautious figure into its most overstated one, silently, on the
      day a meter is installed. So a period qualifies only if every day the array produced
      in it also has a mains reading; otherwise the period falls back to the estimate. That
      makes recent months measured and lifetime estimated, which is exactly the truth.
    */
    const coveredByMains = (keep: (date: string) => boolean): DailyEnergyDto[] | null => {
      if (mainsByDate === null) return null;
      const days = dailyProduction.filter((row) => keep(row.date) && row.energyWh > 0);
      if (days.length === 0) return null;
      return days.every((row) => mainsByDate.has(row.date)) ? days : null;
    };

    const selfConsumed = (keep: (date: string) => boolean, producedWh: number): number => {
      const days = coveredByMains(keep);
      if (days) {
        const exportedKwh = days.reduce((total, row) => total + (mainsByDate?.get(row.date) ?? 0), 0);
        return selfConsumedFromMains(producedWh / 1000, exportedKwh);
      }
      return Math.max(measuredSelfConsumed(keep), (producedWh / 1000) * assumedShare);
    };
    /** True when the figure above leaned on the owner's estimate rather than a measurement. */
    const leanedOnEstimate = (keep: (date: string) => boolean, producedWh: number): boolean =>
      coveredByMains(keep) === null && (producedWh / 1000) * assumedShare > measuredSelfConsumed(keep);

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
    const [todayP, month, year, lifetime] = windows.map(([wh, keep]) =>
      this.buildPeriod(
        wh,
        selfConsumed(keep, wh),
        // Estimated only when the assumption actually lifted the measurement — and never
        // when a mains clamp covered the period, because then nothing was assumed at all.
        leanedOnEstimate(keep, wh),
        retail,
        program,
        hourly ? buildBuckets(hourly.production, hourly.selfConsumption, keep) : undefined,
      ),
    );

    const value: SavingsDto = {
      rates: {
        retailPerKwh: retail,
        hstRate,
        perKwh: programRates(program, retail),
        marginal: marginalValue(program, retail),
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
 * Guard a tax rate read from storage.
 *
 * A stored -1 would make the pre-tax divisor Infinity and every money field NaN, which
 * serializes to null and renders as blank rather than as an error.
 */
function hstOf(raw: number): number {
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0;
}
