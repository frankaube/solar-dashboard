import { localDateOf } from '../common/localdate';

/**
 * One calendar day of the roof, on a fixed axis.
 *
 * The rolling twenty-four-hour chart answers "what is happening now" and is the wrong shape
 * for "what did the roof do on the fourth" — half of it is the previous day, which is what
 * made a yesterday overlay incoherent when it was tried there. A day pinned to midnight has
 * neither problem: the axis means the same thing every time you open it, and the day before
 * lands exactly on top of it.
 *
 * Days are the site's local days, taken from the `localDate` the collector already stamps on
 * every reading. Deriving them from timestamps here would be a second implementation of the
 * one decision that must not disagree with itself — which day a reading counts toward.
 */

export interface DayPoint {
  t: string;
  powerW: number;
  /**
   * The day's energy so far, in Wh.
   *
   * The gateway's own cumulative counter, not an integral of the power curve. It survives
   * any gap in collection, which an integral does not — a morning this app missed would
   * leave a curve that steps up when polling resumes rather than one that quietly
   * under-reports the whole day.
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
 * Move a day's readings onto another day's clock.
 *
 * For the comparison overlay: the previous day's curve has to sit on the same axis as the
 * day being viewed, and the axis is a real date. Shifted by whole local days rather than by
 * a fixed 86,400,000 ms, so a comparison that spans a daylight-saving change still lines up
 * by wall clock — which is what the eye is comparing.
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
 * The day's total, from the gateway's cumulative counter.
 *
 * The maximum rather than a sum of the curve: the counter is cumulative and lives on the
 * gateway, so it survives any gap in collection. Integrating the five-minute samples would
 * quietly under-report every day this app was not watching — including the three and a half
 * hours it missed this morning.
 */
export function dayEnergyWh(readings: Array<{ dailyEnergy: number }>): number | null {
  if (!readings.length) return null;
  return readings.reduce((max, row) => Math.max(max, row.dailyEnergy), 0);
}
