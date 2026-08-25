import { describe, expect, it } from 'vitest';
import { dailyOutlook, describeOutlook } from '../src/readings/solar-outlook';

/*
  Pinned against a figure computed a different way: the analytics service sums hourly
  irradiance × factor and gets 80,781 Wh for 1 August, from a daily radiation sum of
  21.6 MJ/m² and a learned factor of 13.4657. A wrong unit constant makes the two disagree.
*/
const FACTOR = 13.465727699530516;

describe('dailyOutlook', () => {
  it('agrees with the hourly calculation to within rounding', () => {
    const [day] = dailyOutlook([{ date: '2026-08-01', radiationSum: 21.6 }], FACTOR);
    expect(day.expectedWh).toBeGreaterThan(80_000);
    expect(day.expectedWh).toBeLessThan(81_600);
  });

  it('converts MJ/m² to Wh/m² at 277.78, not 1000', () => {
    // A factor-of-3.6 error reads as a disappointing forecast rather than a broken one.
    const [day] = dailyOutlook([{ date: 'd', radiationSum: 1 }], 1);
    expect(day.expectedWh).toBe(278);
  });

  it('covers every day it is given', () => {
    const days = dailyOutlook(
      [
        { date: '2026-07-31', radiationSum: 19.34 },
        { date: '2026-08-01', radiationSum: 21.6 },
        { date: '2026-08-02', radiationSum: 18.48 },
      ],
      FACTOR,
    );
    expect(days.map((d) => d.date)).toEqual(['2026-07-31', '2026-08-01', '2026-08-02']);
    expect(days.every((d) => d.expectedWh > 60_000)).toBe(true);
  });

  it('returns nothing at all when the factor is unknown', () => {
    // No nameplate fallback: a nameplate figure is indistinguishable on screen from a
    // learned one and is wrong by whatever the array's real losses are.
    expect(dailyOutlook([{ date: 'd', radiationSum: 20 }], null)).toEqual([]);
    expect(dailyOutlook([{ date: 'd', radiationSum: 20 }], 0)).toEqual([]);
  });

  it('skips days with no radiation figure rather than reporting zero', () => {
    // Zero expected output and "the forecast omitted this day" are different claims.
    const days = dailyOutlook(
      [
        { date: 'a', radiationSum: null },
        { date: 'b', radiationSum: 20 },
      ],
      FACTOR,
    );
    expect(days.map((d) => d.date)).toEqual(['b']);
  });
});

describe('describeOutlook', () => {
  const best = 109_900; // this array's best day so far

  it('reads a day against what this roof actually does', () => {
    expect(describeOutlook(100_000, best)).toMatch(/near your best/);
    expect(describeOutlook(80_000, best)).toMatch(/a good day/);
    expect(describeOutlook(45_000, best)).toMatch(/moderate/);
    expect(describeOutlook(10_000, best)).toMatch(/poor/);
  });

  it('always leads with the number', () => {
    // The adjective is context; the kWh is the fact.
    for (const wh of [10_000, 50_000, 100_000]) {
      expect(describeOutlook(wh, best)).toMatch(/^~\d+ kWh/);
    }
  });

  it('still gives a number when there is no history to compare against', () => {
    expect(describeOutlook(80_000, null)).toBe('~80 kWh expected');
    expect(describeOutlook(80_000, 0)).toBe('~80 kWh expected');
  });
});
