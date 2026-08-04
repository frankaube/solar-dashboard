import { SITE_TIMEZONE, localDateOf } from '../common/localdate';

/**
 * When a backup is due.
 *
 * Kept as pure functions rather than living inside the service, because the whole point
 * of a schedule is behaviour at times you are not there to watch — 3 AM, the day the
 * clocks change, the morning after a reboot. That is only checkable if it can be called
 * with an arbitrary "now".
 *
 * Two rules, and the split between them is deliberate:
 *
 * - Sub-daily frequencies just measure elapsed time. Nobody cares which minute a
 *   six-hourly backup lands on, and pinning it to a clock would only add ways to miss.
 * - Daily and longer are anchored to an hour you choose. Without that, the schedule
 *   drifts to whatever moment you happened to press Save — a backup at 14:30 competes
 *   with the collector and with you actually using the thing.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How much early is close enough for an anchored run.
 *
 * A daily backup that succeeded at 03:07 yesterday has only 23 h 53 m of elapsed time
 * when today's 03:00 slot comes round. Demanding a full interval would push it to
 * tomorrow, and from then on it would run every other day.
 *
 * Fixed, not a fraction of the interval. A proportional grace of even half would let
 * "weekly" fire on day four — the slot condition is satisfied every day, so the elapsed
 * check is the only thing holding the interval, and it has to hold it tightly.
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
 * Clamp to a real hour. A stored 25 must not silently mean "never".
 *
 * Absent is checked before the numeric range, because `Number(null)` and `Number('')`
 * are both 0 — an install that had never chosen an hour would otherwise anchor to
 * midnight and look deliberate.
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
 * The local calendar day of the most recent `hour:00`.
 *
 * Expressed as a date string rather than an instant on purpose: turning a local
 * wall-clock time back into a UTC instant needs offset arithmetic that goes wrong twice
 * a year, and comparing local (day, hour) pairs answers the same question without it.
 */
function slotDay(now: Date, hour: number, timeZone: string): string {
  const today = localDateOf(now, timeZone);
  return localHourOf(now, timeZone) >= hour ? today : previousLocalDay(today);
}

function ranBeforeSlot(last: Date, now: Date, hour: number, timeZone: string): boolean {
  const slot = slotDay(now, hour, timeZone);
  const lastDay = localDateOf(last, timeZone);
  // ISO dates compare correctly as plain strings, which is why the format is worth keeping.
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
   * The last backup the SCHEDULE ran. Distinct from lastSuccess on purpose.
   *
   * A backup taken by hand, or by a deploy, used to move the anchor — so an install
   * deployed to at 08:00 found only 19 h elapsed when 03:00 came round, skipped the night,
   * and did not run until 03:00 the day after. Deploy most days and the nightly slot never
   * fires at all, while the status panel reports daily backups happening. They are
   * happening; the schedule is not.
   */
  lastScheduled?: Date | null;
  frequency: string;
  hour: number;
  timeZone?: string;
}): boolean {
  const spec = findFrequency(frequency);
  if (!spec || spec.ms === 0) return false;
  // Never backed up at all: do it now rather than waiting for the first anchor to come
  // round. This is the genuinely fresh install, and it wants a backup today.
  if (!lastSuccess) return true;

  // Sub-daily frequencies have no anchor to protect, and nobody wants an hourly backup
  // firing an hour after they took one by hand. Any success counts.
  if (!spec.anchored) return now.getTime() - lastSuccess.getTime() >= spec.ms;

  /*
    Anchored to the last SCHEDULED run, falling back to any success when the schedule has
    never run — an install upgraded from before this distinction existed.

    The fallback matters and the interval check must survive it: an earlier attempt fired
    on the slot alone when no anchor existed, which turned a weekly schedule into a daily
    one. It costs one cycle to converge — the first scheduled run writes a real anchor at
    the slot hour, and from then on ad-hoc backups cannot move it.
  */
  const anchor = lastScheduled ?? lastSuccess;
  const elapsed = now.getTime() - anchor.getTime();
  if (elapsed < spec.ms - ANCHOR_GRACE_MS) return false;
  return ranBeforeSlot(anchor, now, normaliseHour(hour), timeZone);
}

/** How the schedule reads in a sentence, for the UI and the logs. */
export function describeSchedule(frequency: string, hour: number): string {
  const spec = findFrequency(frequency);
  if (!spec || spec.ms === 0) return 'Only when you ask';
  if (!spec.anchored) return spec.label;
  return `${spec.label} at ${String(normaliseHour(hour)).padStart(2, '0')}:00`;
}
