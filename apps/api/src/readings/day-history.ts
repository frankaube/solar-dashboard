import { localDateOf } from '../common/localdate';

/**
 * One calendar day of the roof, on a fixed axis. The rolling 24-hour chart cannot serve this
 * — half of it is the previous day, so a day-over-day overlay has nothing to sit on.
 *
 * Days are the site's local days, taken from the `localDate` the collector stamps on every
 * reading. Deriving them from timestamps here would be a second implementation of which day
 * a reading counts toward.
 */

export interface DayPoint {
  t: string;
  powerW: number;
  /**
   * The day's energy so far, in Wh. The gateway's cumulative counter, not an integral of the
   * power curve: it survives collection gaps, which an integral does not.
   */
  energyWh: number;
}

/** Valid `YYYY-MM-DD`, and a real date rather than a plausible-looking string. */
export function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  return (
    asDate.getUTCFullYear() === y && asDate.getUTCMonth() === m - 1 && asDate.getUTCDate() === d
  );
}

/** The local day before this one. Calendar arithmetic, so month and year ends are free. */
export function previousLocalDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return at.toISOString().slice(0, 10);
}

/** The local day after. Used to stop navigation walking into the future. */
export function nextLocalDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
  return at.toISOString().slice(0, 10);
}

/** Today, in the site's timezone rather than the server's. */
export function todayLocalDate(now: Date = new Date()): string {
  return localDateOf(now);
}

/**
 * Move a day's readings onto another day's clock, for the comparison overlay. Shifted by
 * whole local days rather than a fixed 86,400,000 ms, so a comparison spanning a
 * daylight-saving change still lines up by wall clock.
 */
export function shiftToDay(points: DayPoint[], target: string, timeZone?: string): DayPoint[] {
  return points.map((point) => {
    const at = new Date(point.t);
    const wall = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(at);
    return { t: `${target}T${wall}`, powerW: point.powerW, energyWh: point.energyWh };
  });
}

export interface DayHistory {
  date: string;
  points: DayPoint[];
  /** The gateway's own counter for the day, in Wh. Null when the day has no readings. */
  energyWh: number | null;
  /** How many of the points came from an imported vendor export rather than a poll. */
  importedPoints: number;
}

/**
 * The day's total, from the gateway's cumulative counter. The MAXIMUM, not a sum of the
 * curve: the counter lives on the gateway and survives collection gaps, while integrating
 * the five-minute samples under-reports every day the app was not watching.
 */
export function dayEnergyWh(readings: Array<{ dailyEnergy: number }>): number | null {
  if (!readings.length) return null;
  return readings.reduce((max, row) => Math.max(max, row.dailyEnergy), 0);
}
