import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SITE_TIMEZONE, localDateOf } from '../common/localdate';
import { WeatherService } from '../weather/weather.service';
import { ReadingsService } from './readings.service';
import { DayOutlook, dailyOutlook } from './solar-outlook';

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
   * How many output/irradiance pairs the median above was taken over.
   *
   * Only pairs that cleared the irradiance floor with the array actually producing — not
   * every point on the chart. The distinction matters wherever this figure is judged for
   * trustworthiness: `points` includes the night, where irradiance is a measured zero
   * rather than a missing value, so counting those would make any sample threshold pass
   * automatically and mean nothing.
   */
  learningSamples: number;
  points: ExpectedActualPoint[];
  tomorrowForecastWh: number | null;
  /** Best contiguous plug-in window tomorrow for solar-covered charging. */
  chargeWindow: ChargeWindowDto | null;
  /**
   * Expected output per forecast day, from this array's learned response.
   *
   * Empty when the response has not been learned yet — the alternative would be a
   * nameplate guess, which looks the same on screen and is wrong by the array's real
   * losses. Being measured is the only reason this number is worth showing.
   */
  outlook: DayOutlook[];
}

/** Expected solar output below this isn't worth plugging in for. */
const CHARGE_WINDOW_MIN_KW = 2;
/** The car can't take more than this from the wall (Model Y LR on a Gen 3 WC). */
const CHARGE_MAX_KW = 11.5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
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

    const irradianceAt = (timestamp: number): number | null => {
      let best: { dt: number; value: number } | null = null;
      for (const sample of weatherHistory) {
        if (sample.irradiance === null) continue;
        const dt = Math.abs(new Date(sample.t).getTime() - timestamp);
        if (dt <= PAIRING_WINDOW_MS && (best === null || dt < best.dt)) {
          best = { dt, value: sample.irradiance };
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
    const points: ExpectedActualPoint[] = power
      .filter((point) => new Date(point.t).getTime() >= cutoff)
      .map((point) => {
        const irradiance = irradianceAt(new Date(point.t).getTime());
        return {
          t: point.t,
          actualW: point.powerW,
          expectedW: factor !== null && irradiance !== null ? irradiance * factor : null,
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

    const rows: Array<{ pvPortId: number; takenAt: Date; power: unknown }> =
      await this.prisma.portReading.findMany({
        where: { takenAt: { gte: since } },
        select: { pvPortId: true, takenAt: true, power: true },
        orderBy: { takenAt: 'asc' },
      });

    // Group readings sharing an inverter + timestamp so we can compare siblings.
    const groups = new Map<string, Array<{ portId: number; power: number }>>();
    for (const row of rows) {
      const meta = portMeta.get(row.pvPortId);
      if (!meta) continue;
      const key = `${meta.inverterId}|${row.takenAt.toISOString()}`;
      const list = groups.get(key) ?? [];
      list.push({ portId: row.pvPortId, power: Number(row.power) });
      groups.set(key, list);
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

    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      const ref = median(members.map((m) => m.power));
      if (ref < PANEL_ACTIVE_W) continue; // ignore night/dawn
      const hour = new Date(key.split('|')[1]).getUTCHours() - 3; // ADT
      const localHour = (hour + 24) % 24;
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
    const rows = await this.prisma.inverterReading.findMany({
      where: { takenAt: { gte: since } },
      select: { id: true, temperature: true, activePower: true },
    });
    return rows
      .filter((row) => Number(row.id) % SCATTER_SAMPLE_MODULO === 0)
      .map((row) => ({ temperature: Number(row.temperature), powerW: Number(row.activePower) }));
  }

  /**
   * Sampled (grid voltage, power) pairs. Line voltage rises as the system
   * exports more; if it nears the grid ceiling the inverters curtail — this
   * scatter makes that relationship visible.
   */
  async getVoltagePower(hours: number): Promise<Array<{ voltage: number; powerW: number }>> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const rows = await this.prisma.inverterReading.findMany({
      where: { takenAt: { gte: since } },
      select: { id: true, gridVoltage: true, activePower: true },
    });
    return rows
      .filter((row) => Number(row.id) % SCATTER_SAMPLE_MODULO === 0)
      .map((row) => ({ voltage: Number(row.gridVoltage), powerW: Number(row.activePower) }));
  }
}
