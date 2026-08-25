import { SITE_TIMEZONE, localDateOf } from '../common/localdate';

/**
 * Pure functions, so DST days and post-reboot cases can be called with an arbitrary "now".
 * Sub-daily frequencies measure elapsed time only; daily and longer are anchored to a chosen
 * hour, or they drift to whenever Save was pressed.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * A daily run that succeeded at 03:07 has 23 h 53 m elapsed at the next 03:00 slot, so a
 * full interval would push it to tomorrow and thereafter to alternate days. Fixed, not a
 * fraction of the interval: the slot condition holds every day, so the elapsed check is the
 * only thing bounding the interval, and a half-interval grace lets "weekly" fire on day four.
 */
const ANCHOR_GRACE_MS = 2 * HOUR;

export interface Frequency {
  id: string;
  label: string;
  ms: number;
  /** Whether the preferred hour applies. False for anything under a day. */
  anchored: boolean;
}

export const FREQUENCIES: Frequency[] = [
  { id: 'off', label: 'Only when I ask', ms: 0, anchored: false },
  { id: '6h', label: 'Every 6 hours', ms: 6 * HOUR, anchored: false },
  { id: '12h', label: 'Every 12 hours', ms: 12 * HOUR, anchored: false },
  { id: 'daily', label: 'Daily', ms: DAY, anchored: true },
  { id: 'weekly', label: 'Weekly', ms: 7 * DAY, anchored: true },
  { id: 'monthly', label: 'Every 30 days', ms: 30 * DAY, anchored: true },
];

export const DEFAULT_FREQUENCY = 'off';
export const DEFAULT_HOUR = 3;

export function findFrequency(id: string | null | undefined): Frequency | undefined {
  return FREQUENCIES.find((frequency) => frequency.id === id);
}

/**
 * Clamp to a real hour. Absent is checked before the numeric range: `Number(null)` and
 * `Number('')` are both 0, which would anchor an unconfigured install to midnight.
 */
export function normaliseHour(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_HOUR;
  const hour = Math.trunc(Number(value));
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_HOUR;
}

function localHourOf(date: Date, timeZone: string): number {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(date);
  // Some ICU builds render midnight as 24, which would sort after every real hour.
  return Number(text) % 24;
}

function previousLocalDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) - DAY);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * A date string rather than an instant: local wall-clock to UTC needs offset arithmetic that
 * goes wrong at each DST transition, and comparing (day, hour) pairs avoids it.
 */
function slotDay(now: Date, hour: number, timeZone: string): string {
  const today = localDateOf(now, timeZone);
  return localHourOf(now, timeZone) >= hour ? today : previousLocalDay(today);
}

function ranBeforeSlot(last: Date, now: Date, hour: number, timeZone: string): boolean {
  const slot = slotDay(now, hour, timeZone);
  const lastDay = localDateOf(last, timeZone);
  // ISO dates compare correctly as plain strings.
  if (lastDay !== slot) return lastDay < slot;
  return localHourOf(last, timeZone) < hour;
}

export function isDue({
  now,
  lastSuccess,
  lastScheduled = null,
  frequency,
  hour,
  timeZone = SITE_TIMEZONE,
}: {
  now: Date;
  /** Any successful backup, however it was triggered. */
  lastSuccess: Date | null;
  /**
   * The last backup the SCHEDULE ran. Must stay distinct from lastSuccess: were an ad-hoc
   * backup to move the anchor, one taken at 08:00 leaves 19 h elapsed at 03:00 and the
   * slot is skipped.
   */
  lastScheduled?: Date | null;
  frequency: string;
  hour: number;
  timeZone?: string;
}): boolean {
  const spec = findFrequency(frequency);
  if (!spec || spec.ms === 0) return false;
  if (!lastSuccess) return true;

  if (!spec.anchored) return now.getTime() - lastSuccess.getTime() >= spec.ms;

  // Falls back to any success when the schedule has never run (an upgraded install). The
  // interval check must still apply there: the slot alone would make weekly fire daily.
  const anchor = lastScheduled ?? lastSuccess;
  const elapsed = now.getTime() - anchor.getTime();
  if (elapsed < spec.ms - ANCHOR_GRACE_MS) return false;
  return ranBeforeSlot(anchor, now, normaliseHour(hour), timeZone);
}

export function describeSchedule(frequency: string, hour: number): string {
  const spec = findFrequency(frequency);
  if (!spec || spec.ms === 0) return 'Only when you ask';
  if (!spec.anchored) return spec.label;
  return `${spec.label} at ${String(normaliseHour(hour)).padStart(2, '0')}:00`;
}
