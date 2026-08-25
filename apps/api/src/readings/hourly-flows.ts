import { FlowBucket } from './reward-programs';
import { localDateOf } from '../common/localdate';

/**
 * Turn power samples into the hourly buckets a time-of-use tariff needs.
 *
 * Readings are instantaneous watts at the poll interval, so energy is the integral of power
 * over time, and the samples are irregular — an unreachable gateway leaves a gap.
 *
 * Buckets are keyed on LOCAL wall-clock time: a tariff's peak window is "4pm to 9pm" where
 * the meter is, and UTC would shift every kWh by the offset — at UTC-3, the whole evening
 * peak into the shoulder.
 */

/** Longer than this between samples and we assume the collector was down. */
export const MAX_SAMPLE_GAP_MS = 10 * 60_000;

export interface PowerSample {
  takenAt: Date;
  /** Instantaneous watts. Sign is the caller's convention. */
  watts: number;
}

export interface LocalParts {
  hour: number;
  month: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Local hour, month and weekday for an instant. Intl rather than UTC-offset arithmetic: the
 * offset moves twice a year, and a fixed one mis-buckets every reading for half of it.
 */
export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
    month: 'numeric',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // "24" appears at midnight in some ICU versions with hour12:false.
  const hour = Number(get('hour')) % 24;
  return {
    hour,
    month: Number(get('month')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/**
 * Keyed by local DATE as well as hour, so one pass over the readings serves every period.
 * Without the date, buckets would only know they were a Wednesday at 3pm, not which one.
 */
type BucketKey = string;

function keyOf(date: string, parts: LocalParts): BucketKey {
  return `${date}|${parts.month}|${parts.weekday}|${parts.hour}`;
}

/**
 * The local calendar date an instant falls on, as YYYY-MM-DD. Delegates to localDateOf,
 * which assembles from named parts — en-CA formatting yields ISO only where that locale
 * exists, and the packaged build ships small-icu.
 */
export function localDate(date: Date, timeZone: string): string {
  return localDateOf(date, timeZone);
}

/**
 * Integrate a power series into per-hour energy, keyed by local hour/month/weekday.
 *
 * `select` picks the watts that count — production takes them as-is, battery discharge only
 * the negative side — so one integrator serves every series.
 *
 * Energy is attributed to the hour the sample STARTS in, so an interval straddling an hour
 * boundary is counted whole in the earlier hour. At a five-minute poll that is at most five
 * minutes of misattribution per hour, well under the error in the self-consumption figure.
 */
export function integrateHourly(
  samples: PowerSample[],
  timeZone: string,
  select: (watts: number) => number = (w) => w,
): Map<BucketKey, number> {
  const out = new Map<BucketKey, number>();
  for (let i = 0; i < samples.length - 1; i++) {
    const watts = select(samples[i].watts);
    if (watts <= 0) continue;
    const gapMs = samples[i + 1].takenAt.getTime() - samples[i].takenAt.getTime();
    if (gapMs <= 0) continue;
    const hours = Math.min(gapMs, MAX_SAMPLE_GAP_MS) / 3_600_000;
    const at = samples[i].takenAt;
    const key = keyOf(localDate(at, timeZone), localParts(at, timeZone));
    out.set(key, (out.get(key) ?? 0) + (watts * hours) / 1000);
  }
  return out;
}

/**
 * Assemble the buckets a programme is valued over.
 *
 * Self-consumption is capped at production per bucket, as in the period totals: it is
 * measured from EV charging and battery discharge, both of which can run on grid power at
 * night, and attributing those to solar would invent production — at the peak rate under a
 * time-of-use tariff.
 */
export function buildBuckets(
  production: Map<BucketKey, number>,
  selfConsumption: Map<BucketKey, number>,
  /** Restrict to a period — e.g. `(d) => d.startsWith('2026-07')`. */
  keep: (localDate: string) => boolean = () => true,
): FlowBucket[] {
  const keys = new Set([...production.keys(), ...selfConsumption.keys()]);
  const buckets: FlowBucket[] = [];
  for (const key of keys) {
    const [date, month, weekday, hour] = key.split('|');
    if (!keep(date)) continue;
    const producedKwh = production.get(key) ?? 0;
    const selfConsumedKwh = Math.min(producedKwh, selfConsumption.get(key) ?? 0);
    buckets.push({
      hour: Number(hour),
      month: Number(month),
      weekday: Number(weekday),
      producedKwh,
      selfConsumedKwh,
      exportedKwh: Math.max(0, producedKwh - selfConsumedKwh),
    });
  }
  return buckets;
}

/** Total kWh across buckets, for reconciling against the period figures. */
export function totalProduced(buckets: FlowBucket[]): number {
  return buckets.reduce((sum, b) => sum + b.producedKwh, 0);
}
