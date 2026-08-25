import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SITE_TIMEZONE, localDateOf } from '../common/localdate';
import { yesterdayFor } from './yesterday';
import { WeatherService } from '../weather/weather.service';
import { ReadingsService } from './readings.service';
import { DayOutlook, dailyOutlook } from './solar-outlook';
import { ClipSample, detectClipping } from './clipping';
import { PANEL_WATTS_SETTING_KEY } from '../system/array-census.service';

/** Irradiance below this is dawn/dusk noise — excluded from factor learning. */
const MIN_LEARNING_IRRADIANCE = 200;
/** Max clock skew when pairing a power sample with a weather sample. */
const PAIRING_WINDOW_MS = 10 * 60_000;
const LEARNING_WINDOW_HOURS = 72;
const SCATTER_SAMPLE_MODULO = 4;
// Panel-insight tuning.
const PANEL_ACTIVE_W = 50; // sibling median above which a comparison is meaningful
const PANEL_HEALTHY_RATIO = 0.9; // >= this vs siblings = healthy, not flagged
const SOILING_RATIO = 0.6; // below this all-day = likely fault
const HOUR_SHARE_THRESHOLD = 0.12; // an hour holding >12% of the loss "counts"
const SHADING_MAX_HOURS = 5; // deficit within this many hours reads as shading
/** Nameplate assumed when neither the panel nor the paperwork says. Common modern module size. */
const DEFAULT_PANEL_W = 400;
const MIN_SAMPLES = 30;
const MIN_SAMPLE_MINUTES = 5;

export interface PanelInsightDto {
  portId: number;
  panel: string;
  deficitPct: number;
  lostWhPerDay: number;
  diagnosis: string;
  pattern: 'shading' | 'all-day';
}

export interface ExpectedActualPoint {
  t: string;
  actualW: number;
  expectedW: number | null;
  /**
   * What the array was doing at this wall-clock time yesterday. Only for points on TODAY:
   * half the rolling window is already yesterday, and "yesterday" against those means the
   * day before. Null where yesterday has no nearby reading; never interpolated.
   */
  yesterdayW: number | null;
}

export interface ChargeWindowDto {
  start: string;
  end: string;
  estKwh: number;
  avgKw: number;
}

export interface ProductionAnalyticsDto {
  /** Learned system response: watts of AC output per W/m² of irradiance. */
  wattsPerIrradiance: number | null;
  /**
   * How many output/irradiance pairs the median was taken over — only those clearing
   * MIN_LEARNING_IRRADIANCE with the array producing, unlike `points`, which includes the
   * night where irradiance is a measured zero.
   */
  learningSamples: number;
  points: ExpectedActualPoint[];
  tomorrowForecastWh: number | null;
  /** Best contiguous plug-in window tomorrow for solar-covered charging. */
  chargeWindow: ChargeWindowDto | null;
  /**
   * Expected output per forecast day, from this array's learned response. Empty until the
   * response is learned; a nameplate guess would be wrong by the array's real losses.
   */
  outlook: DayOutlook[];
}

/** Expected solar output below this isn't worth plugging in for. */
const CHARGE_WINDOW_MIN_KW = 2;
/** The car can't take more than this from the wall (Model Y LR on a Gen 3 WC). */
const CHARGE_MAX_KW = 11.5;

/**
 * The site's local hour for an instant. Decides which hour a panel's losses are attributed
 * to, so a fixed UTC offset would flip a deficit between shading and soiling. Memoised —
 * Intl calls are expensive, and a week of readings holds only 168 distinct hours — keyed on
 * the hour so the cache cannot grow with the data. The zone is a parameter, not read from
 * SITE_TIMEZONE at module load, so the result cannot depend on the host machine.
 */
const HOUR_CACHE = new Map<string, Map<number, number>>();
const HOUR_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function hourFormatter(timeZone: string): Intl.DateTimeFormat {
  const found = HOUR_FORMATTERS.get(timeZone);
  if (found) return found;
  const made = new Intl.DateTimeFormat('en-CA', { timeZone, hour: '2-digit', hour12: false });
  HOUR_FORMATTERS.set(timeZone, made);
  return made;
}

export function localHourOf(at: number, timeZone: string = SITE_TIMEZONE): number {
  /*
    Nested rather than a composed `${zone}:${bucket}` key: this runs once per reading, and
    building a string on every call would give back much of what memoising bought.
  */
  let byBucket = HOUR_CACHE.get(timeZone);
  if (byBucket === undefined) {
    byBucket = new Map<number, number>();
    HOUR_CACHE.set(timeZone, byBucket);
  }
  const bucket = Math.floor(at / 3_600_000);
  const found = byBucket.get(bucket);
  if (found !== undefined) return found;
  // "24" for midnight in some locales; the modulo keeps it in range either way.
  const hour = Number(hourFormatter(timeZone).format(new Date(at))) % 24;
  byBucket.set(bucket, hour);
  return hour;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Last four hex digits of a serial, matching the labels on the roof map. */
function hexTail(serial: string): string {
  try {
    return BigInt(serial).toString(16).toUpperCase().slice(-4);
  } catch {
    // Serials are decimal strings today; BigInt throws on anything else.
    return String(serial).toUpperCase().slice(-4);
  }
}

export interface ClippingDto {
  inverterSerial: string;
  /** Last four hex digits — the label used everywhere else on the roof. */
  label: string;
  ports: number;
  ceilingAcW: number;
  plateauEfficiencyPct: number;
  topEfficiencyPct: number;
  lostWhPerDay: number;
  firstSeen: string;
  lastSeen: string;
}


/** The best a single panel has ever done, and when. All-time, not windowed. */
export interface PanelRecordDto {
  portId: number;
  /** "8982·3" — the same short name the roof map and tooltips use. */
  panel: string;
  peakW: number;
  /** When it happened, ISO. */
  at: string;
  ratedW: number;
  /** Peak as a share of the panel's own nameplate, 0-100. */
  pctOfRated: number;
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readings: ReadingsService,
    private readonly weather: WeatherService,
  ) {}

  async getProductionAnalytics(hours: number): Promise<ProductionAnalyticsDto> {
    const [power, weatherHistory] = await Promise.all([
      this.readings.getPowerHistory(Math.max(hours, LEARNING_WINDOW_HOURS)),
      this.readings.getWeatherHistory(LEARNING_WINDOW_HOURS),
    ]);

    /*
      Weather timestamps parsed once, not once per comparison: `irradianceAt` walks this
      whole series for every power sample, ~62,000 conversions over a 72-hour window.
    */
    const samples = weatherHistory
      .filter((sample) => sample.irradiance !== null)
      .map((sample) => ({ at: new Date(sample.t).getTime(), value: sample.irradiance as number }));

    const irradianceAt = (timestamp: number): number | null => {
      let best: { dt: number; value: number } | null = null;
      for (const sample of samples) {
        const dt = Math.abs(sample.at - timestamp);
        if (dt <= PAIRING_WINDOW_MS && (best === null || dt < best.dt)) {
          best = { dt, value: sample.value };
        }
      }
      return best?.value ?? null;
    };

    const ratios: number[] = [];
    for (const point of power) {
      const irradiance = irradianceAt(new Date(point.t).getTime());
      if (irradiance !== null && irradiance >= MIN_LEARNING_IRRADIANCE && point.powerW > 0) {
        ratios.push(point.powerW / irradiance);
      }
    }
    const factor = ratios.length ? median(ratios) : null;

    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const visible = power.filter((point) => new Date(point.t).getTime() >= cutoff);
    // Yesterday comes from the same 72-hour pull the learning window needed — no extra query.
    const yesterday = yesterdayFor(visible, power);
    // So the half of the window that is already yesterday gets no comparison against the
    // day before it.
    const today = localDateOf(new Date());
    const points: ExpectedActualPoint[] = visible.map((point, index) => {
      const irradiance = irradianceAt(new Date(point.t).getTime());
      const isToday = localDateOf(new Date(point.t)) === today;
      return {
        t: point.t,
        actualW: point.powerW,
        expectedW: factor !== null && irradiance !== null ? irradiance * factor : null,
        yesterdayW: isToday ? (yesterday[index] ?? null) : null,
      };
    });

    return {
      wattsPerIrradiance: factor,
      learningSamples: ratios.length,
      points,
      tomorrowForecastWh: this.forecastTomorrow(factor),
      chargeWindow: this.chargeWindowTomorrow(factor),
      outlook: dailyOutlook(this.weather.getWeather().forecast ?? [], factor),
    };
  }

  /** Longest contiguous block of forecast hours tomorrow with meaningful expected output. */
  private chargeWindowTomorrow(factor: number | null): ChargeWindowDto | null {
    const { hourly } = this.weather.getWeather();
    if (factor === null || !hourly) return null;
    const tomorrowDate = localDateOf(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const hours: Array<{ time: string; kw: number }> = [];
    for (let i = 0; i < hourly.time.length; i++) {
      if (!hourly.time[i].startsWith(tomorrowDate)) continue;
      hours.push({
        time: hourly.time[i],
        kw: Math.min(((hourly.shortwaveRadiation[i] ?? 0) * factor) / 1000, CHARGE_MAX_KW),
      });
    }
    let best: { start: number; end: number } | null = null;
    let runStart: number | null = null;
    for (let i = 0; i <= hours.length; i++) {
      const good = i < hours.length && hours[i].kw >= CHARGE_WINDOW_MIN_KW;
      if (good && runStart === null) runStart = i;
      if (!good && runStart !== null) {
        if (!best || i - runStart > best.end - best.start) best = { start: runStart, end: i };
        runStart = null;
      }
    }
    if (!best) return null;
    const window = hours.slice(best.start, best.end);
    const estKwh = window.reduce((a, h) => a + h.kw, 0);
    return {
      start: window[0].time,
      end: hours[best.end]?.time ?? window[window.length - 1].time,
      estKwh: Number(estKwh.toFixed(1)),
      avgKw: Number((estKwh / window.length).toFixed(1)),
    };
  }

  /** Sum tomorrow's forecast irradiance (hourly) times the learned response. */
  private forecastTomorrow(factor: number | null): number | null {
    const { hourly } = this.weather.getWeather();
    if (factor === null || !hourly) return null;
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowDate = localDateOf(tomorrow);
    let wh = 0;
    let found = false;
    for (let i = 0; i < hourly.time.length; i++) {
      // Open-Meteo hourly times are already in the local timezone (timezone=auto).
      if (!hourly.time[i].startsWith(tomorrowDate)) continue;
      found = true;
      wh += (hourly.shortwaveRadiation[i] ?? 0) * factor;
    }
    return found ? Math.round(wh) : null;
  }

  /**
   * Per-panel underperformance insights. For each PV port, compare its power to
   * its inverter siblings at the same instant; a sustained deficit is flagged
   * and diagnosed by *when* it happens — a deficit concentrated in specific
   * hours is shading, an all-day deficit is soiling or a hardware fault.
   */
  async getPanelInsights(days: number): Promise<PanelInsightDto[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const ports = await this.prisma.pvPort.findMany({ include: { microinverter: true } });
    const portMeta = new Map(
      ports.map((p) => [
        p.id,
        {
          inverterId: p.microinverterId,
          serial: p.microinverter.serialNumber.toString(),
          portNumber: p.portNumber,
          label: p.panelLabel,
        },
      ]),
    );

    /*
      Raw, not findMany: Prisma hydrates a model object per row — 76,000 at seven days,
      ~27 us each on the Pi, 2.1 s against an 11 ms query, scaling linearly with the window.
      Night is excluded in SQL because the loop discards it anyway. Filtered on the
      TIMESTAMP, not the row: a panel sitting at zero while its siblings work is the fault
      this endpoint exists to find, so its rows must still be fetched.
    */
    const rows = await this.prisma.$queryRaw<Array<{ pvPortId: number; takenAt: number | bigint; power: number }>>`
      SELECT pr."pvPortId", pr."takenAt", pr."power"
      FROM "PortReading" pr
      WHERE pr."takenAt" >= ${since}
        AND pr."takenAt" IN (
          SELECT "takenAt" FROM "PortReading"
          WHERE "takenAt" >= ${since}
          GROUP BY "takenAt"
          HAVING MAX("power") >= ${PANEL_ACTIVE_W}
        )
      ORDER BY pr."takenAt" ASC`;

    /*
      Group readings sharing an inverter and a timestamp, so siblings can be compared. Keyed
      on the millisecond number, not an ISO string — 76,000 date-to-string conversions for
      keys only ever compared to each other.
    */
    const groups = new Map<string, { at: number; members: Array<{ portId: number; power: number }> }>();
    for (const row of rows) {
      const meta = portMeta.get(row.pvPortId);
      if (!meta) continue;
      const at = Number(row.takenAt);
      const key = `${meta.inverterId}|${at}`;
      const group = groups.get(key) ?? { at, members: [] };
      group.members.push({ portId: row.pvPortId, power: Number(row.power) });
      groups.set(key, group);
    }

    interface Acc {
      expected: number;
      actual: number;
      lostWh: number;
      byHour: number[];
      samples: number;
    }
    const stats = new Map<number, Acc>();
    const median = (v: number[]): number => {
      const s = [...v].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const SAMPLE_HOURS = MIN_SAMPLE_MINUTES / 60;

    for (const group of groups.values()) {
      const members = group.members;
      if (members.length < 2) continue;
      const ref = median(members.map((m) => m.power));
      if (ref < PANEL_ACTIVE_W) continue; // ignore night/dawn
      const localHour = localHourOf(group.at);
      for (const member of members) {
        const acc = stats.get(member.portId) ?? {
          expected: 0,
          actual: 0,
          lostWh: 0,
          byHour: new Array(24).fill(0),
          samples: 0,
        };
        acc.expected += ref;
        acc.actual += member.power;
        const deficit = Math.max(0, ref - member.power);
        acc.lostWh += deficit * SAMPLE_HOURS;
        acc.byHour[localHour] += deficit;
        acc.samples++;
        stats.set(member.portId, acc);
      }
    }

    const insights: PanelInsightDto[] = [];
    for (const [portId, acc] of stats) {
      if (acc.samples < MIN_SAMPLES || acc.expected <= 0) continue;
      const ratio = acc.actual / acc.expected;
      if (ratio >= PANEL_HEALTHY_RATIO) continue;
      const meta = portMeta.get(portId)!;
      const totalDeficit = acc.byHour.reduce((a, b) => a + b, 0);
      // Hours holding the bulk of the loss.
      const ranked = acc.byHour
        .map((v, h) => ({ h, share: totalDeficit ? v / totalDeficit : 0 }))
        .filter((x) => x.share > HOUR_SHARE_THRESHOLD)
        .map((x) => x.h)
        .sort((a, b) => a - b);
      const concentrated = ranked.length > 0 && ranked.length <= SHADING_MAX_HOURS;
      insights.push({
        portId,
        panel: meta.label ?? `${meta.serial.slice(-4)}·${meta.portNumber}`,
        deficitPct: Math.round((1 - ratio) * 100),
        lostWhPerDay: Math.round(acc.lostWh / days),
        diagnosis: concentrated
          ? `Shading — losses concentrate ${ranked[0]}:00–${ranked[ranked.length - 1] + 1}:00`
          : ratio < SOILING_RATIO
            ? 'Likely fault or heavy soiling — deficit all day'
            : 'Soiling or mild all-day loss',
        pattern: concentrated ? 'shading' : 'all-day',
      });
    }
    return insights.sort((a, b) => b.lostWhPerDay - a.lostWhPerDay);
  }

  /** Sampled (temperature, power) pairs for the scatter view. */
  async getTemperaturePower(
    hours: number,
  ): Promise<Array<{ temperature: number; powerW: number }>> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    /*
      Sampled in SQL, not after the fact: the scatter wants one reading in four, and
      fetching all four marshals four times the rows it draws.
    */
    const rows = await this.prisma.$queryRaw<Array<{ temperature: number; activePower: number }>>`
      SELECT "temperature", "activePower"
      FROM "InverterReading"
      WHERE "takenAt" >= ${since} AND "id" % ${SCATTER_SAMPLE_MODULO} = 0`;
    return rows.map((row) => ({
      temperature: Number(row.temperature),
      powerW: Number(row.activePower),
    }));
  }

  /**
   * Sampled (grid voltage, power) pairs. Line voltage rises as the system
   * exports more; if it nears the grid ceiling the inverters curtail — this
   * scatter makes that relationship visible.
   */
  async getVoltagePower(hours: number): Promise<Array<{ voltage: number; powerW: number }>> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    /*
      Sampled in SQL, not after the fact: the scatter wants one reading in four, and
      fetching all four marshals four times the rows it draws.
    */
    const rows = await this.prisma.$queryRaw<Array<{ gridVoltage: number; activePower: number }>>`
      SELECT "gridVoltage", "activePower"
      FROM "InverterReading"
      WHERE "takenAt" >= ${since} AND "id" % ${SCATTER_SAMPLE_MODULO} = 0`;
    return rows.map((row) => ({
      voltage: Number(row.gridVoltage),
      powerW: Number(row.activePower),
    }));
  }

  /**
   * Which microinverters are hitting their AC ceiling. Empty is the normal answer: on this
   * array conversion held at 94.81% from 600 W to 1500 W DC with no rolloff — but that was
   * measured in high summer, when heat suppresses output and clipping is least likely.
   *
   * See clipping.ts for why efficiency-against-DC is the test, not an output histogram.
   */
  async getClipping(days: number): Promise<ClippingDto[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    /*
      DC and AC paired at the same instant; DC is a sum across an inverter's ports. In SQL
      for the reason getPanelInsights gives: a month of per-port rows runs to six figures.
    */
    const rows = await this.prisma.$queryRaw<
      Array<{
        microinverterId: number;
        serialNumber: bigint | number;
        ports: bigint | number;
        at: number | bigint;
        dcW: number;
        acW: number;
      }>
    >`
      SELECT m."id"           AS "microinverterId",
             m."serialNumber" AS "serialNumber",
             (SELECT COUNT(*) FROM "PvPort" p WHERE p."microinverterId" = m."id") AS "ports",
             r."takenAt"      AS "at",
             dc."dcW"         AS "dcW",
             r."activePower"  AS "acW"
      FROM "InverterReading" r
      JOIN "Microinverter" m ON m."id" = r."microinverterId"
      JOIN (
        SELECT p."microinverterId" AS mid, pr."takenAt" AS t, SUM(pr."power") AS "dcW"
        FROM "PortReading" pr
        JOIN "PvPort" p ON p."id" = pr."pvPortId"
        WHERE pr."takenAt" >= ${since}
        GROUP BY p."microinverterId", pr."takenAt"
      ) dc ON dc."mid" = r."microinverterId" AND dc."t" = r."takenAt"
      WHERE r."takenAt" >= ${since}`;

    const byInverter = new Map<number, { serial: string; ports: number; samples: ClipSample[] }>();
    for (const row of rows) {
      const id = Number(row.microinverterId);
      let entry = byInverter.get(id);
      if (!entry) {
        entry = { serial: String(row.serialNumber), ports: Number(row.ports), samples: [] };
        byInverter.set(id, entry);
      }
      entry.samples.push({ at: Number(row.at), dcW: Number(row.dcW), acW: Number(row.acW) });
    }

    const found: ClippingDto[] = [];
    for (const entry of byInverter.values()) {
      const clip = detectClipping(entry.samples);
      if (!clip) continue;
      found.push({
        inverterSerial: entry.serial,
        label: hexTail(entry.serial),
        ports: entry.ports,
        ceilingAcW: clip.ceilingAcW,
        plateauEfficiencyPct: Math.round(clip.plateauEfficiency * 1000) / 10,
        topEfficiencyPct: Math.round(clip.topEfficiency * 1000) / 10,
        lostWhPerDay: clip.lostWhPerDay,
        firstSeen: new Date(clip.firstAt).toISOString(),
        lastSeen: new Date(clip.lastAt).toISOString(),
      });
    }
    // Worst first.
    return found.sort((a, b) => b.lostWhPerDay - a.lostWhPerDay);
  }

  /**
   * Every panel's personal best, and the moment it happened. All-time, not windowed.
   *
   * Rated wattage falls back to the contract figure when a panel has no stored nameplate,
   * so one missing number does not blank pctOfRated for the whole roof.
   */
  async getPanelRecords(): Promise<PanelRecordDto[]> {
    const ports = await this.prisma.pvPort.findMany({ include: { microinverter: true } });
    const fallbackW = (await this.getContractPanelWatts()) ?? DEFAULT_PANEL_W;

    /*
      MAX() with bare columns beside it: SQLite guarantees they come from the row that
      produced the maximum, so "and when" is free in the same scan. A SQLite extension, not
      standard SQL — this shape is undefined behaviour in Postgres.
    */
    const rows = await this.prisma.$queryRaw<
      Array<{ portId: number; peakW: number; at: number | bigint }>
    >`
      SELECT pr."pvPortId" AS "portId",
             MAX(pr."power") AS "peakW",
             pr."takenAt"    AS "at"
      FROM "PortReading" pr
      GROUP BY pr."pvPortId"`;

    const records: PanelRecordDto[] = [];
    for (const row of rows) {
      const port = ports.find((candidate) => candidate.id === Number(row.portId));
      if (!port) continue;
      const peakW = Number(row.peakW);
      if (!(peakW > 0)) continue;
      const ratedW = port.panelWattage && port.panelWattage > 0 ? port.panelWattage : fallbackW;
      records.push({
        portId: port.id,
        panel: port.panelLabel ?? `${hexTail(port.microinverter.serialNumber.toString())}·${port.portNumber}`,
        peakW: Math.round(peakW * 10) / 10,
        at: new Date(Number(row.at)).toISOString(),
        ratedW,
        pctOfRated: Math.round((peakW / ratedW) * 1000) / 10,
      });
    }
    // Best first.
    return records.sort((a, b) => b.peakW - a.peakW);
  }

  /** The nameplate from the install paperwork, for panels with nothing stored of their own. */
  private async getContractPanelWatts(): Promise<number | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: PANEL_WATTS_SETTING_KEY } });
    const value = Number(row?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
}
