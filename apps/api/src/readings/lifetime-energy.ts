/**
 * Deriving a day's production from a lifetime accumulator.
 *
 * Some gateways report only a monotonic lifetime counter and no daily figure —
 * SunSpec inverters publish "WH" and nothing else. For those, a day's production is
 * the counter's span across that day: last minus first.
 *
 * Separate from DailyCounterTracker, which guards a RESETTING counter against failing to
 * reset at midnight. This one reads a counter that never resets.
 */

export interface LifetimeSample {
  /** The accumulator reading. Null on sources that do not publish one. */
  lifetimeEnergy: number | null;
}

/**
 * Span of a lifetime counter over one day's samples. Null when the day cannot be measured:
 * no samples, no counter, or only one reading — a single sample spans zero, which would
 * read as "produced nothing today". Null lets the caller fall back to the daily figure.
 */
export function dailyFromLifetime(samples: LifetimeSample[]): number | null {
  const values = samples
    .map((s) => s.lifetimeEnergy)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length < 2) return null;

  const first = values[0];
  const last = values[values.length - 1];
  const span = last - first;

  /*
    A negative span means the counter went backwards: a replaced inverter, a firmware reset,
    or a wrapped counter. Not production, and it would show up as a large negative day.
  */
  if (span < 0) return null;
  return span;
}
