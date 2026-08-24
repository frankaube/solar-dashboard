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
 *
 * Six missed polls at the five-minute interval. Past that the figure is not yesterday at
 * this hour, it is yesterday at whatever hour the collector last managed.
 */
const YESTERDAY_STALE_MS = 30 * 60_000;

const PRICE_SETTING_KEY = 'electricityPricePerKwh';
const SYSTEM_COST_SETTING_KEY = 'systemCostCad';
const HST_SETTING_KEY = 'hstRate';
const RATED_KW_SETTING_KEY = 'systemRatedKw';
/** Which tariff values the energy. Absent means net metering, the previous behaviour. */
const PROGRAM_SETTING_KEY = 'rewardProgramId';
/**
 * Whether the configured price already has sales tax in it.
 *
 * Defaults to true, which is what every existing install has been assumed to mean — so
 * nobody's numbers move until they say otherwise. Bills print the pre-tax energy rate,
 * though, so "false" is the honest answer more often than not.
 */
const PRICE_INCLUDES_TAX_KEY = 'priceIncludesTax';
/**
 * Share of generation used in the house as it is made, when nothing measures it.
 *
 * The app can only see solar diverted to an EV or a battery; the fridge, the heat pumps
 * and the water heater are invisible without a whole-home meter. On this install that
 * makes measured self-consumption read 1%, which is certainly wrong and quietly values
 * nearly every kWh at the export rate.
 */
const SELF_CONSUMPTION_KEY = 'selfConsumptionPct';
/** Whether to use the share measured from meter data instead of the typed one. */
export const SELF_CONSUMPTION_AUTO_KEY = 'selfConsumptionAuto';

const DEFAULT_PRICE_PER_KWH = 0.16;
const DEFAULT_HST_RATE = 0.15;
/**
 * Only used to *estimate* array size before the owner tells us. The rated size is a fact
 * about their hardware that nothing on the wire reports — the DTU exposes powerLimitPct
 * (a curtailment setting), not a nameplate — so it has to be configured. Previously this
 * was three disagreeing hardcoded constants in the web app.
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
   * What the roof had made by this clock time yesterday, or null where nothing can say.
   *
   * Null rather than zero: an install younger than a day, or a collection gap across that
   * moment, is not a yesterday that produced nothing.
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
   * kWh per kWp — the only production figure comparable with another house.
   *
   * Null when the array size was estimated rather than configured by the owner. See
   * `specific-yield.ts` for why that refusal matters more than the number.
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
 * Delegates rather than reimplementing. This built the string itself with en-CA, which
 * renders ISO only where that locale exists — and the packaged build ships small-icu,
 * where it does not. The month and year totals slice a prefix off this value, so under
 * small-icu they sliced '7/31/20' and '7/31' and matched nothing: both read zero while
 * lifetime was correct, which is a confusing shape of wrong.
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
   * panels the gateway has registered. Never invent a fixed number — this system is 24 kW
   * (42 × ~570 W), while a hardcoded 21.0 in the UI made every capacity percentage read
   * ~14% high.
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
      The DTU's own panel count beats counting the rows we happen to have.

      They are not the same number: on at least one install AppInfo reports 42 panels
      while the RealData pages carry 38, because a registered, online inverter is
      absent from the per-inverter response while still contributing to the DTU's
      power total. Counting rows told the owner they had a 38-panel array. It also
      fed the capacity estimate below, so an install with no configured rated size
      was understated by the same proportion.
    */
    const panelsTotal = reportedPvCount && reportedPvCount > 0 ? reportedPvCount : storedPanels;
    /*
      The same reasoning for inverters, which had been getting it wrong the whole time.

      "Inverters online" was the reporting inverters counted against `snapshot.inverters.length`
      — the reporting inverters — so it read 11 / 11 and could never show a missing one. It sat
      there saying everything was fine while the census beside it said 11 of 12 were reporting
      and two units were producing nothing. The panel figure next to it, 38 / 46, was right all
      along, which is what made the pair look so odd.

      Zero is not an answer here: a gateway that has never reported a count leaves this null,
      and falling back to what is currently reporting is at least honest about being a floor.
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
   * within one evening, all at 0 W). Taking the newest reading therefore collapsed
   * "today" after sunset — the hero showed $1.01 against a 108 kWh day. The counter
   * only ever legitimately climbs during a day, so the day's maximum is the total.
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
    // accumulator (SunSpec) lands here every day, and would otherwise show a blank
    // hero all afternoon while the roof was working.
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
      // A gateway that has never reported a count leaves the setting empty. What is in front of
      // us is then the best floor available, and it reads x / x, which is where this came from.
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
      // Carried through so an imported point can be told from an observed one. Sent only
      // when it is not the ordinary case, to keep the common payload unchanged.
      ...(row.source !== 'dtu' ? { source: row.source } : {}),
    }));
  }

  /**
   * Per-local-day energy from the DTU's resetting daily counter (max per day).
   * localDate is precomputed at insert time — no SQL timezone math needed.
   */
  /**
   * One local calendar day: the curve, the total, and the day before it for comparison.
   *
   * Selected on `localDate` rather than on a timestamp range. The collector already stamps
   * every reading with the day it counts toward, and re-deriving that from midnight
   * boundaries here would be a second implementation of the one decision that must never
   * disagree with itself.
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

    /*
      The span of the record, so navigation can stop at both ends rather than walking into
      empty days in either direction. Cheap: two indexed lookups of one row each.
    */
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
      A source that publishes only a lifetime accumulator — SunSpec inverters do —
      records dailyEnergy as 0 forever, so those days would read as zero production.
      Where that happens, derive the day from the accumulator's span instead.

      Only fetched for days that actually need it: on a Hoymiles or Fronius install
      every day has a real counter and this query never runs.
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
      // The device's own figure wins wherever it has one; the derived span only fills
      // days it left at zero.
      return {
        date: row.localDate,
        energyWh: reported > 0 ? reported : (derived.get(row.localDate) ?? 0),
      };
    });
  }

  /**
   * How much the roof had made by this time yesterday.
   *
   * "85 yesterday" is yesterday's whole day, which is the wrong thing to hold a part-day
   * against: at nine in the morning it says nothing except that the day is young. What
   * answers "am I having a good day" is the same clock time on the day before.
   *
   * MATCHED ON THE WALL CLOCK, like the tooltip on the power chart. Yesterday at 14:07 and
   * 24 hours ago are the same instant on all but two days a year, and on those two an hour
   * of sun is exactly what is being compared.
   *
   * AT OR BEFORE THAT MOMENT, never the nearest reading. The gateway's counter is
   * cumulative, so "how much by 14:07" is the last reading up to 14:07 — the nearest could
   * sit after it and report energy that had not been made yet.
   *
   * Bounded to yesterday's own local day so a gap cannot reach back into the day before and
   * answer with a different day's total.
   *
   * The zone is a parameter defaulting to the site's, so the tests pin a zone rather than
   * inheriting the machine's and asserting Atlantic answers wherever the developer happens
   * to sit. `localHourOf` had exactly that fault and only CI found it.
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
      A stale reading is not an answer. The counter survives a gap — it lives on the
      gateway — but the last reading BEFORE the gap does not: if yesterday went quiet from
      ten until three, the newest row at or before 14:07 holds the morning's total and
      would present a four-hour hole as a bad afternoon. Silence is the honest reply.
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

    // Same non-monotonic-counter trap as getSummary: the newest reading is not the
    // day's total once the gateway starts winding down.
    const snapshot = this.collector.getLastSnapshot();
    const todayWh = Math.max(
      snapshot?.dailyEnergyWh ?? 0,
      daily.find((row) => row.date === today)?.energyWh ?? 0,
    );
    const monthWh = sumWhere((date) => date.startsWith(monthPrefix));
    const yearWh = sumWhere((date) => date.startsWith(yearPrefix));

    /*
      The latest lifetime counter on each port, summed.

      Written as a join against each port's newest reading rather than as a window function.
      Both are valid SQLite and Postgres and both return the same number; the difference is
      what the planner can do with the index.

      PortReading is indexed on (pvPortId, takenAt) ascending, and the window's ORDER BY is
      descending — so SQLite read all 135,736 rows and built a temporary B-tree to sort them,
      every time anyone opened the Money page. Measured on the Pi: 787 ms against 48 ms for
      this form, for an identical answer. It was the single slowest thing in the app.

      The grouped subquery only has to seek the last entry in each port's index range, which
      is a few dozen seeks rather than a full scan, and it stays cheap as history grows —
      which the scan very much did not.
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
        Null whenever the array size was estimated rather than configured. The estimate is
        panel count times an assumed 500 W, so a yield derived from it is a measurement
        divided by a guess — and it would render identically to the real one.
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
