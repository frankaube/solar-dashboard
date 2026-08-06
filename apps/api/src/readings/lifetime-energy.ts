/**
 * Deriving a day's production from a lifetime accumulator.
 *
 * Some gateways report only a monotonic lifetime counter and no daily figure —
 * SunSpec inverters publish "WH" and nothing else. For those, a day's production is
 * the counter's span across that day: last minus first.
 *
 * This is deliberately separate from DailyCounterTracker, which solves the opposite
 * problem. That one guards a RESETTING counter against failing to reset at midnight.
 * This one reads a counter that never resets. Conflating them is how a reasonable
 * person ends up subtracting a rollover from a carry-over.
 */

export interface LifetimeSample {
  /** The accumulator reading. Null on sources that do not publish one. */
  lifetimeEnergy: number | null;
}

/**
 * Span of a lifetime counter over one day's samples.
 *
 * Returns null when the day cannot be measured — no samples, no counter, or only one
 * reading. One reading is the case worth being careful about: a single sample gives a
 * span of zero, which would report "produced nothing today" on a day we simply have
 * not observed for long enough. Null says we do not know, and the caller can fall
 * back to whatever the source's own daily figure was.
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
    A negative span means the counter went backwards. That is not production, it is a
    replaced inverter, a firmware reset, or a device whose counter wrapped — all real,
    and all of which would otherwise show up as a large negative day. Report nothing
    rather than a number we cannot explain.
  */
  if (span < 0) return null;
  return span;
}
