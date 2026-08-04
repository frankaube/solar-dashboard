import { describe, expect, it } from 'vitest';
import { dailyFromLifetime } from '../src/readings/lifetime-energy';

const samples = (...values: Array<number | null>) => values.map((lifetimeEnergy) => ({ lifetimeEnergy }));

/**
 * SunSpec inverters publish only a lifetime accumulator, so a day's production has
 * to be its span. The edge cases all share a shape: several plausible reasons for a
 * strange span, none of which is "produced a negative amount of electricity".
 */
describe('dailyFromLifetime', () => {
  it('takes the span across the day', () => {
    expect(dailyFromLifetime(samples(1_000_000, 1_012_400, 1_034_800))).toBe(34_800);
  });

  it('is zero on a day that genuinely produced nothing', () => {
    // Distinct from "unknown": we watched all day and the counter never moved.
    expect(dailyFromLifetime(samples(500_000, 500_000, 500_000))).toBe(0);
  });

  it('returns null on a single reading rather than claiming zero', () => {
    // One sample gives a span of zero, which would report "produced nothing today" on
    // a day we simply have not watched long enough — the first poll after a restart,
    // or the first minutes of a new day.
    expect(dailyFromLifetime(samples(1_000_000))).toBeNull();
    expect(dailyFromLifetime([])).toBeNull();
  });

  it('returns null when the counter goes backwards', () => {
    // A replaced inverter, a firmware reset, or a wrapped counter. All real, none of
    // them production, and all of which would otherwise plot as a huge negative day.
    expect(dailyFromLifetime(samples(9_000_000, 12_000))).toBeNull();
  });

  it('ignores samples with no accumulator', () => {
    // Sources that report a real daily counter leave the column null, and a mixed
    // history exists on any install that switched gateways.
    expect(dailyFromLifetime(samples(null, 1_000_000, null, 1_005_000, null))).toBe(5_000);
  });

  it('returns null when nothing in the day has an accumulator', () => {
    expect(dailyFromLifetime(samples(null, null, null))).toBeNull();
  });

  it('ignores non-finite values rather than producing NaN', () => {
    // A NaN span would serialize to null and render the day blank, which looks like
    // a data gap rather than a bad reading.
    expect(dailyFromLifetime(samples(NaN, 1_000_000, 1_002_000, Infinity))).toBe(2_000);
  });

  it('uses first and last, not min and max', () => {
    // A monotonic counter makes these identical, but if a bogus spike ever lands
    // mid-day, min/max would silently absorb it into the total while first/last
    // stays anchored to the day's real endpoints.
    expect(dailyFromLifetime(samples(1_000, 9_999_999, 2_000))).toBe(1_000);
  });
});
