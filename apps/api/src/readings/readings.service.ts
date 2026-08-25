import { Injectable } from '@nestjs/common';
import { DayHistory, dayEnergyWh, previousLocalDate, shiftToDay } from './day-history';
import { PrismaService } from '../prisma/prisma.service';
import { CollectorService } from '../collector/collector.service';
import { SystemSnapshot } from '../hoymiles/types';
import { dailyFromLifetime } from './lifetime-energy';
import { INVERTER_COUNT_SETTING_KEY, PV_COUNT_SETTING_KEY } from '../common/settings-keys';
import { SITE_TIMEZONE, localDateOf } from '../common/localdate';
import { SpecificYieldDto, summariseYield } from './specific-yield';
import { sameClockYesterday } from './yesterday';

/**
 * How old the last reading before "this time yesterday" may be and still answer for it.
 * Six missed polls at the five-minute interval.
 */
const YESTERDAY_STALE_MS = 30 * 60_000;

const PRICE_SETTING_KEY = 'electricityPricePerKwh';
const SYSTEM_COST_SETTING_KEY = 'systemCostCad';
const HST_SETTING_KEY = 'hstRate';
const RATED_KW_SETTING_KEY = 'systemRatedKw';
/** Which tariff values the energy. Absent means net metering, the previous behaviour. */
const PROGRAM_SETTING_KEY = 'rewardProgramId';
/**
 * Whether the configured price already has sales tax in it. Defaults to true, which is
 * what existing installs assume. Bills print the pre-tax energy rate.
 */
const PRICE_INCLUDES_TAX_KEY = 'priceIncludesTax';
/**
 * Share of generation used in the house as it is made, when nothing measures it.
 *
 * Only solar diverted to an EV or a battery is visible; ordinary loads need a whole-home
 * meter. Measured self-consumption therefore reads ~1% here, which would value nearly
 * every kWh at the export rate.
 */
const SELF_CONSUMPTION_KEY = 'selfConsumptionPct';
/** Whether to use the share measured from meter data instead of the typed one. */
export const SELF_CONSUMPTION_AUTO_KEY = 'selfConsumptionAuto';

const DEFAULT_PRICE_PER_KWH = 0.16;
const DEFAULT_HST_RATE = 0.15;
/**
 * Only used to *estimate* array size before the owner configures it. Nothing on the wire
 * reports rated size — the DTU exposes powerLimitPct (a curtailment setting), not a
 * nameplate.
 */
const ASSUMED_PANEL_W = 500;
const WH_PER_KWH = 1000;
/** Approximate grid emission intensity. A national average, not a configurable one yet. */
const CO2_KG_PER_KWH = 0.29;
const ROLLUP_WINDOW_DAYS = 366;
const PERCENT = 100;

export interface SummaryDto {
  updatedAt: string | null;
  currentPowerW: number;
  todayEnergyWh: number;
  todayRevenue: number;
  pricePerKwh: number;
  gridVoltage: number | null;
  gridFrequency: number | null;
  invertersOnline: number;
  invertersTotal: number;
  /** Rated array size in kW — configured by the owner, or estimated from panel count. */
  ratedKw: number;
  /** Whether ratedKw is the owner's figure (true) or our estimate (false). */
  ratedKwConfigured: boolean;
  /** Panels registered by the gateway — the honest denominator for "N of M reporting". */
  panelsTotal: number;
}

export interface PowerPointDto {
  t: string;
  powerW: number;
  /** Absent for readings this app polled; "cloud" for a point imported to fill a gap. */
  source?: string;
}

export interface DailyEnergyDto {
  date: string;
  energyWh: number;
}

/** One local day, with the day before it when a comparison was asked for. */
export interface DayHistoryDto extends DayHistory {
  /** The previous day, already moved onto this day's clock so both share an axis. */
  previous: DayHistory | null;
  /** The span of the record, so navigation can stop where the data does. */
  earliest: string | null;
  latest: string | null;
}

export interface EnergyStatsDto {
  todayWh: number;
  /**
   * What the roof had made by this clock time yesterday. Null rather than zero: an install
   * younger than a day, or a gap across that moment, is not a day that produced nothing.
   */
  yesterdayAtThisTimeWh: number | null;
  monthWh: number;
  yearWh: number;
  lifetimeWh: number;
  pricePerKwh: number;
  savings: { today: number; month: number; year: number; lifetime: number };
  systemCostCad: number | null;
  paybackProgressPct: number | null;
  co2SavedKg: number;
  /**
   * kWh per kWp — the only production figure comparable with another house. Null when the
   * array size was estimated rather than configured. See `specific-yield.ts`.
   */
  specificYield: SpecificYieldDto | null;
  records: {
    bestDayDate: string | null;
    bestDayWh: number;
    peakPowerW: number;
    peakPowerAt: string | null;
    daysCollecting: number;
  };
}

/**
 * Today's date as YYYY-MM-DD in the array's local timezone.
 *
 * Must delegate: formatting with en-CA yields ISO only where that locale exists, and the
 * packaged build ships small-icu, where it renders '7/31/2025'. Month and year totals
 * slice a prefix off this value and would match nothing.
 */
function localDateString(): string {
  return localDateOf(new Date());
}

const CO2_PER_KWH = 0.29;
const MWH_WH = 1_000_000;
const ROLLING_WEEK = 7;

export interface MilestonesDto {
  daysCollecting: number;
  firstDate: string | null;
  lifetimeWh: number;
  lifetimeCo2Kg: number;
  avgDayWh: number;
  bestDay: { date: string; wh: number } | null;
  bestMonth: { month: string; wh: number } | null;
  bestWeek: { endDate: string; wh: number } | null;
  peakPowerW: number;
  peakPowerAt: string | null;
  todayIsRecord: boolean;
  producingStreak: number;
  nextMwh: { targetMwh: number; pct: number } | null;
}

@Injectable()
export class ReadingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collector: CollectorService,
  ) {}

  getLive(): SystemSnapshot | null {
    return this.collector.getLastSnapshot();
  }

  /**
   * Array size in kW. The owner's configured figure wins; otherwise estimate from the
   * panels the gateway has registered. Never a fixed constant — it varies per install.
   */
  private async getRatedKw(): Promise<{
    ratedKw: number;
    configured: boolean;
    panelsTotal: number;
    invertersTotal: number;
  }> {
    const [configured, storedPanels, reportedPvCount, reportedInverters] = await Promise.all([
      this.getNumberSetting(RATED_KW_SETTING_KEY, null),
      this.prisma.pvPort.count(),
      this.getNumberSetting(PV_COUNT_SETTING_KEY, null),
      this.getNumberSetting(INVERTER_COUNT_SETTING_KEY, null),
    ]);
    /*
      The DTU's own panel count beats counting stored rows. They differ: AppInfo reports 42
      panels while the RealData pages carry 38, because a registered, online inverter can be
      absent from the per-inverter response while still contributing to the DTU power total.
      This also feeds the capacity estimate below.
    */
    const panelsTotal = reportedPvCount && reportedPvCount > 0 ? reportedPvCount : storedPanels;
    /*
      Same for inverters. Counting `snapshot.inverters.length` as the total can only ever
      read N / N and never shows a missing unit. Left at 0 when the gateway has never
      reported a count; the caller falls back to the reporting count as a floor.
    */
    const invertersTotal = reportedInverters && reportedInverters > 0 ? reportedInverters : 0;
    if (configured && configured > 0) {
      return { ratedKw: configured, configured: true, panelsTotal, invertersTotal };
    }
    return {
      ratedKw: (panelsTotal * ASSUMED_PANEL_W) / WH_PER_KWH,
      configured: false,
      panelsTotal,
      invertersTotal,
    };
  }

  /**
   * Energy for the current local day.
   *
   * The gateway's daily counter is NOT monotonic: once production stops it decays to
   * junk rather than holding the day's total (observed 109,334 -> 44,348 -> 6,338 Wh
   * within one evening, all at 0 W). It only ever climbs legitimately, so the day's
   * maximum is the total; the newest reading is not.
   */
  private async todayEnergyWh(snapshotWh: number | undefined): Promise<number> {
    const today = localDateString();
    const rollup = await this.prisma.dtuReading.aggregate({
      where: { localDate: today },
      _max: { dailyEnergy: true },
    });
    const reported = Math.max(snapshotWh ?? 0, rollup._max.dailyEnergy ?? 0);
    if (reported > 0) return reported;

    // Nothing reported a daily figure. A source that publishes only a lifetime
    // accumulator (SunSpec) lands here every day.
    const samples = await this.prisma.dtuReading.findMany({
      where: { localDate: today, lifetimeEnergy: { not: null } },
      select: { lifetimeEnergy: true },
      orderBy: { takenAt: 'asc' },
    });
    return dailyFromLifetime(samples) ?? 0;
  }

  async getSummary(): Promise<SummaryDto> {
    const snapshot = this.collector.getLastSnapshot();
    const [pricePerKwh, rated, todayWh] = await Promise.all([
      this.getNumberSetting(PRICE_SETTING_KEY, DEFAULT_PRICE_PER_KWH),
      this.getRatedKw(),
      this.todayEnergyWh(snapshot?.dailyEnergyWh),
    ]);
    const sizing = {
      ratedKw: rated.ratedKw,
      ratedKwConfigured: rated.configured,
      panelsTotal: rated.panelsTotal,
      invertersTotal: rated.invertersTotal,
    };
    if (!snapshot) {
      return {
        updatedAt: null,
        currentPowerW: 0,
        todayEnergyWh: todayWh,
        todayRevenue: (todayWh / WH_PER_KWH) * pricePerKwh,
        pricePerKwh,
        gridVoltage: null,
        gridFrequency: null,
        invertersOnline: 0,
        ...sizing,
      };
    }
    const online = snapshot.inverters.filter((inv) => inv.linkStatus === 1);
    const average = (values: number[]): number | null =>
      values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return {
      updatedAt: snapshot.takenAt.toISOString(),
      currentPowerW: snapshot.totalPower,
      todayEnergyWh: todayWh,
      todayRevenue: (todayWh / WH_PER_KWH) * pricePerKwh,
      pricePerKwh,
      gridVoltage: average(online.map((inv) => inv.gridVoltage)),
      gridFrequency: average(online.map((inv) => inv.gridFrequency)),
      invertersOnline: online.length,
      ...sizing,
      // A gateway that has never reported a count leaves the setting empty; the reporting
      // inverters are then the best available floor.
      invertersTotal: sizing.invertersTotal || snapshot.inverters.length,
    };
  }

  async getPowerHistory(hours: number): Promise<PowerPointDto[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const rows: Array<{ takenAt: Date; totalPower: unknown; source: string }> =
      await this.prisma.dtuReading.findMany({
        where: { takenAt: { gte: since } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, totalPower: true, source: true },
      });
    return rows.map((row) => ({
      t: row.takenAt.toISOString(),
      powerW: Number(row.totalPower),
      // Only sent when it is not the ordinary case, to keep the common payload unchanged.
      ...(row.source !== 'dtu' ? { source: row.source } : {}),
    }));
  }

  /**
   * One local calendar day: the curve, the total, and the day before it for comparison.
   *
   * Selected on `localDate`, not on a timestamp range: the collector stamps every reading
   * with the day it counts toward, and re-deriving midnight boundaries here would be a
   * second implementation of that decision.
   */
  async getDay(date: string, compare: boolean): Promise<DayHistoryDto> {
    const wanted = compare ? [date, previousLocalDate(date)] : [date];
    const rows: Array<{ takenAt: Date; totalPower: unknown; dailyEnergy: number; localDate: string; source: string }> =
      await this.prisma.dtuReading.findMany({
        where: { localDate: { in: wanted } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, totalPower: true, dailyEnergy: true, localDate: true, source: true },
      });

    const forDate = (which: string): DayHistory => {
      const mine = rows.filter((row) => row.localDate === which);
      return {
        date: which,
        points: mine.map((row) => ({
          t: row.takenAt.toISOString(),
          powerW: Number(row.totalPower),
          energyWh: row.dailyEnergy,
        })),
        energyWh: dayEnergyWh(mine),
        importedPoints: mine.filter((row) => row.source === 'cloud').length,
      };
    };

    // The span of the record, so navigation can stop at both ends. Two indexed lookups.
    const [oldest, newest] = await Promise.all([
      this.prisma.dtuReading.findFirst({ orderBy: { localDate: 'asc' }, select: { localDate: true } }),
      this.prisma.dtuReading.findFirst({ orderBy: { localDate: 'desc' }, select: { localDate: true } }),
    ]);

    const day = forDate(date);
    const previous = compare ? forDate(previousLocalDate(date)) : null;
    return {
      ...day,
      // Laid onto the viewed day's clock, so the two curves share one axis.
      previous:
        previous && previous.points.length
          ? { ...previous, points: shiftToDay(previous.points, date, SITE_TIMEZONE) }
          : null,
      earliest: oldest?.localDate ?? null,
      latest: newest?.localDate ?? null,
    };
  }

  async getDailyEnergy(days: number): Promise<DailyEnergyDto[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.dtuReading.groupBy({
      by: ['localDate'],
      where: { takenAt: { gte: since } },
      _max: { dailyEnergy: true },
      orderBy: { localDate: 'asc' },
    });

    /*
      A source that publishes only a lifetime accumulator — SunSpec inverters do — records
      dailyEnergy as 0 forever, so derive those days from the accumulator's span. Only
      fetched for days that need it; on Hoymiles or Fronius this query never runs.
      */
    const needsDerivation = rows.filter((row) => (row._max.dailyEnergy ?? 0) === 0);
    const derived = new Map<string, number>();
    if (needsDerivation.length > 0) {
      const samples = await this.prisma.dtuReading.findMany({
        where: {
          localDate: { in: needsDerivation.map((r) => r.localDate) },
          lifetimeEnergy: { not: null },
        },
        select: { localDate: true, lifetimeEnergy: true },
        orderBy: { takenAt: 'asc' },
      });
      const byDate = new Map<string, Array<{ lifetimeEnergy: number | null }>>();
      for (const s of samples) {
        const list = byDate.get(s.localDate) ?? [];
        list.push({ lifetimeEnergy: s.lifetimeEnergy });
        byDate.set(s.localDate, list);
      }
      for (const [date, list] of byDate) {
        const span = dailyFromLifetime(list);
        if (span !== null) derived.set(date, span);
      }
    }

    return rows.map((row) => {
      const reported = row._max.dailyEnergy ?? 0;
      // The device's figure wins; the derived span only fills days it left at zero.
      return {
        date: row.localDate,
        energyWh: reported > 0 ? reported : (derived.get(row.localDate) ?? 0),
      };
    });
  }

  /**
   * How much the roof had made by this time yesterday — a part-day against the same clock
   * time, not against yesterday's whole-day total.
   *
   * Matched on the wall clock, not 24h back (they differ on DST changeover days, where an
   * hour of sun is what is being compared), and taken AT OR BEFORE that moment rather than
   * nearest, since the counter is cumulative. Bounded to yesterday's own local day so a gap
   * cannot answer with another day's total. The zone is a parameter so tests can pin it.
   */
  private async yesterdayEnergyAtThisTimeWh(
    now: Date = new Date(),
    timeZone: string = SITE_TIMEZONE,
  ): Promise<number | null> {
    const target = sameClockYesterday(now, timeZone);
    const row = await this.prisma.dtuReading.findFirst({
      where: { localDate: localDateOf(target, timeZone), takenAt: { lte: target } },
      orderBy: { takenAt: 'desc' },
      select: { takenAt: true, dailyEnergy: true },
    });
    if (!row) return null;
    /*
      A stale reading is not an answer: the counter survives a collection gap, but the last
      row before the gap holds only the pre-gap total and would present the hole as a bad
      afternoon.
    */
    if (target.getTime() - row.takenAt.getTime() > YESTERDAY_STALE_MS) return null;
    return row.dailyEnergy;
  }

  async getEnergyStats(): Promise<EnergyStatsDto> {
    const daily = await this.getDailyEnergy(ROLLUP_WINDOW_DAYS);
    const today = localDateString();
    const monthPrefix = today.slice(0, 7);
    const yearPrefix = today.slice(0, 4);

    const sumWhere = (predicate: (date: string) => boolean): number =>
      daily.filter((row) => predicate(row.date)).reduce((sum, row) => sum + row.energyWh, 0);

    // Same non-monotonic-counter trap as getSummary: the newest reading is not the total.
    const snapshot = this.collector.getLastSnapshot();
    const todayWh = Math.max(
      snapshot?.dailyEnergyWh ?? 0,
      daily.find((row) => row.date === today)?.energyWh ?? 0,
    );
    const monthWh = sumWhere((date) => date.startsWith(monthPrefix));
    const yearWh = sumWhere((date) => date.startsWith(yearPrefix));

    /*
      The latest lifetime counter on each port, summed. A join against each port's newest
      reading, not a window function: PortReading is indexed on (pvPortId, takenAt) ascending
      while the window's ORDER BY is descending, so SQLite scans every row into a temporary
      B-tree — 787 ms on the Pi against 48 ms here, identical answer. The grouped subquery
      seeks the last entry in each port's index range and stays cheap as history grows.
    */
    const lifetimeRows = await this.prisma.$queryRaw<Array<{ wh: bigint | number }>>`
      SELECT COALESCE(SUM(p."energyTotal"), 0) AS wh
      FROM "PortReading" p
      JOIN (
        SELECT "pvPortId", MAX("takenAt") AS "maxAt"
        FROM "PortReading"
        GROUP BY "pvPortId"
      ) m ON m."pvPortId" = p."pvPortId" AND m."maxAt" = p."takenAt"`;
    // The DTU's lifetime counters update lazily (observed ~12% behind); our own
    // rollups cover the system's whole life, so take whichever is greater.
    const allDaily = await this.prisma.dtuReading.groupBy({
      by: ['localDate'],
      _max: { dailyEnergy: true },
    });
    const rollupLifetimeWh = allDaily.reduce((sum, row) => sum + (row._max.dailyEnergy ?? 0), 0);
    const lifetimeWh = Math.max(Number(lifetimeRows[0]?.wh ?? 0), rollupLifetimeWh);

    const pricePerKwh = await this.getNumberSetting(PRICE_SETTING_KEY, DEFAULT_PRICE_PER_KWH);
    const systemCostCad = await this.getNumberSetting(SYSTEM_COST_SETTING_KEY, null);
    const rated = await this.getRatedKw();
    const toSavings = (wh: number): number => (wh / WH_PER_KWH) * pricePerKwh;
    const lifetimeSavings = toSavings(lifetimeWh);

    const bestDay = daily.reduce(
      (best, row) => (row.energyWh > best.energyWh ? row : best),
      { date: null as string | null, energyWh: 0 },
    );
    const peak = await this.prisma.dtuReading.findFirst({
      orderBy: { totalPower: 'desc' },
      select: { takenAt: true, totalPower: true },
    });

    return {
      todayWh,
      yesterdayAtThisTimeWh: await this.yesterdayEnergyAtThisTimeWh(),
      monthWh,
      yearWh,
      lifetimeWh,
      pricePerKwh,
      savings: {
        today: toSavings(todayWh),
        month: toSavings(monthWh),
        year: toSavings(yearWh),
        lifetime: lifetimeSavings,
      },
      systemCostCad,
      paybackProgressPct: systemCostCad ? (lifetimeSavings / systemCostCad) * PERCENT : null,
      co2SavedKg: (lifetimeWh / WH_PER_KWH) * CO2_KG_PER_KWH,
      /*
        Null whenever the array size was estimated rather than configured: the estimate is
        panel count times an assumed 500 W, so the yield would be a measurement divided by
        a guess, rendered identically to the real one.
      */
      specificYield: summariseYield(daily, rated.ratedKw, rated.configured, today),
      records: {
        bestDayDate: bestDay.date,
        bestDayWh: bestDay.energyWh,
        peakPowerW: peak ? Number(peak.totalPower) : 0,
        peakPowerAt: peak ? peak.takenAt.toISOString() : null,
        daysCollecting: daily.length,
      },
    };
  }

  async getPortHistory(
    portId: number,
    hours: number,
  ): Promise<Array<{ t: string; powerW: number; voltage: number; current: number }>> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const rows: Array<{ takenAt: Date; power: unknown; voltage: unknown; current: unknown }> =
      await this.prisma.portReading.findMany({
        where: { pvPortId: portId, takenAt: { gte: since } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, power: true, voltage: true, current: true },
      });
    return rows.map((row) => ({
      t: row.takenAt.toISOString(),
      powerW: Number(row.power),
      voltage: Number(row.voltage),
      current: Number(row.current),
    }));
  }

  async getWeatherHistory(
    hours: number,
  ): Promise<Array<{ t: string; irradiance: number | null; cloudCover: number }>> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const rows: Array<{ takenAt: Date; shortwaveRadiation: unknown; cloudCover: number }> =
      await this.prisma.weatherReading.findMany({
        where: { takenAt: { gte: since } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, shortwaveRadiation: true, cloudCover: true },
      });
    return rows.map((row) => ({
      t: row.takenAt.toISOString(),
      irradiance: row.shortwaveRadiation === null ? null : Number(row.shortwaveRadiation),
      cloudCover: row.cloudCover,
    }));
  }

  async getMilestones(): Promise<MilestonesDto> {
    const daily = await this.getDailyEnergy(ROLLUP_WINDOW_DAYS * 30); // effectively all history
    const today = localDateString();

    const bestDay = daily.reduce<{ date: string; wh: number } | null>(
      (best, row) => (!best || row.energyWh > best.wh ? { date: row.date, wh: row.energyWh } : best),
      null,
    );

    const byMonth = new Map<string, number>();
    for (const row of daily) {
      const month = row.date.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + row.energyWh);
    }
    let bestMonth: { month: string; wh: number } | null = null;
    for (const [month, wh] of byMonth) {
      if (!bestMonth || wh > bestMonth.wh) bestMonth = { month, wh };
    }

    // Best rolling 7 calendar days (by index in the sorted day list).
    let bestWeek: { endDate: string; wh: number } | null = null;
    for (let i = ROLLING_WEEK - 1; i < daily.length; i++) {
      let sum = 0;
      for (let j = i - ROLLING_WEEK + 1; j <= i; j++) sum += daily[j].energyWh;
      if (!bestWeek || sum > bestWeek.wh) bestWeek = { endDate: daily[i].date, wh: sum };
    }

    // Producing streak: consecutive most-recent days with meaningful output.
    let streak = 0;
    for (let i = daily.length - 1; i >= 0; i--) {
      if (daily[i].energyWh > 1000) streak++;
      else break;
    }

    const peak = await this.prisma.dtuReading.findFirst({
      orderBy: { totalPower: 'desc' },
      select: { takenAt: true, totalPower: true },
    });
    const lifetimeWh = daily.reduce((sum, row) => sum + row.energyWh, 0);
    const avgDayWh = daily.length ? Math.round(lifetimeWh / daily.length) : 0;
    const nextTargetMwh = Math.floor(lifetimeWh / MWH_WH) + 1;

    return {
      daysCollecting: daily.length,
      firstDate: daily[0]?.date ?? null,
      lifetimeWh,
      lifetimeCo2Kg: (lifetimeWh / 1000) * CO2_PER_KWH,
      avgDayWh,
      bestDay,
      bestMonth,
      bestWeek,
      peakPowerW: peak ? Number(peak.totalPower) : 0,
      peakPowerAt: peak ? peak.takenAt.toISOString() : null,
      todayIsRecord: bestDay?.date === today,
      producingStreak: streak,
      nextMwh: {
        targetMwh: nextTargetMwh,
        pct: (lifetimeWh / (nextTargetMwh * MWH_WH)) * 100,
      },
    };
  }

  async getNumberSetting(key: string, fallback: number): Promise<number>;
  async getNumberSetting(key: string, fallback: null): Promise<number | null>;
  async getNumberSetting(key: string, fallback: number | null): Promise<number | null> {
    const setting = await this.prisma.setting.findUnique({ where: { key } });
    const parsed = setting ? Number(setting.value) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  async getStringSetting(key: string, fallback: string): Promise<string> {
    const setting = await this.prisma.setting.findUnique({ where: { key } });
    return setting?.value ?? fallback;
  }

  async setStringSetting(key: string, value: string): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async setNumberSetting(key: string, value: number): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value: String(value) },
      update: { value: String(value) },
    });
  }

  async getConfig(): Promise<{
    electricityPricePerKwh: number;
    systemCostCad: number | null;
    hstRate: number;
    systemRatedKw: number | null;
    rewardProgramId: string;
    priceIncludesTax: boolean;
    selfConsumptionPct: number | null;
    /** True when the share is measured from imported meter data rather than typed. */
    selfConsumptionAuto: boolean;
  }> {
    return {
      electricityPricePerKwh: await this.getNumberSetting(
        PRICE_SETTING_KEY,
        DEFAULT_PRICE_PER_KWH,
      ),
      systemCostCad: await this.getNumberSetting(SYSTEM_COST_SETTING_KEY, null),
      hstRate: await this.getNumberSetting(HST_SETTING_KEY, DEFAULT_HST_RATE),
      systemRatedKw: await this.getNumberSetting(RATED_KW_SETTING_KEY, null),
      rewardProgramId: await this.getStringSetting(PROGRAM_SETTING_KEY, 'net-metering'),
      priceIncludesTax: (await this.getStringSetting(PRICE_INCLUDES_TAX_KEY, '1')) !== '0',
      selfConsumptionPct: await this.getNumberSetting(SELF_CONSUMPTION_KEY, null),
      // Off unless asked for, so nobody's figures move under them on an upgrade.
      selfConsumptionAuto: (await this.getStringSetting(SELF_CONSUMPTION_AUTO_KEY, '0')) === '1',
    };
  }

  async setConfig(
    price: number | null,
    systemCost: number | null,
    hstRate: number | null = null,
    ratedKw: number | null = null,
    rewardProgramId: string | null = null,
    priceIncludesTax: boolean | null = null,
    selfConsumptionPct: number | null = null,
    selfConsumptionAuto: boolean | null = null,
  ): Promise<void> {
    if (price !== null) await this.setNumberSetting(PRICE_SETTING_KEY, price);
    if (systemCost !== null) await this.setNumberSetting(SYSTEM_COST_SETTING_KEY, systemCost);
    if (hstRate !== null) await this.setNumberSetting(HST_SETTING_KEY, hstRate);
    if (ratedKw !== null) await this.setNumberSetting(RATED_KW_SETTING_KEY, ratedKw);
    if (rewardProgramId !== null) await this.setStringSetting(PROGRAM_SETTING_KEY, rewardProgramId);
    if (priceIncludesTax !== null) {
      await this.setStringSetting(PRICE_INCLUDES_TAX_KEY, priceIncludesTax ? '1' : '0');
    }
    // -1 is the caller saying "forget the assumption", which a positive-number setter
    // cannot express any other way.
    if (selfConsumptionPct !== null) {
      await this.setNumberSetting(SELF_CONSUMPTION_KEY, selfConsumptionPct < 0 ? 0 : selfConsumptionPct);
    }
    if (selfConsumptionAuto !== null) {
      await this.setStringSetting(SELF_CONSUMPTION_AUTO_KEY, selfConsumptionAuto ? '1' : '0');
    }
  }
}
