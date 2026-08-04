import { describe, expect, it } from 'vitest';
import { DailyCounterTracker } from '../src/common/daily-counter';

/**
 * Regression tests for the midnight-carryover bug. The scenario in the first test is the
 * real one observed on 2026-07-24, where the day opened with four rows holding 39,985 Wh
 * — 2026-07-23's final total — because the DTU's counter reset ~15 minutes late.
 */
describe('DailyCounterTracker', () => {
  it('suppresses the previous day’s total until the counter actually resets', () => {
    const t = new DailyCounterTracker();
    // Tail of 2026-07-23: production over, counter parked at the day's total.
    expect(t.resolve('2026-07-23', 39985)).toBe(39985);
    // Local midnight passes; the DTU is still reporting yesterday's number.
    expect(t.resolve('2026-07-24', 39985)).toBe(0);
    expect(t.resolve('2026-07-24', 39985)).toBe(0);
    expect(t.carryingOver).toBe(true);
    // Counter finally resets — from here the readings are genuinely today's.
    expect(t.resolve('2026-07-24', 0)).toBe(0);
    expect(t.carryingOver).toBe(false);
    expect(t.resolve('2026-07-24', 120)).toBe(120);
    expect(t.resolve('2026-07-24', 5400)).toBe(5400);
  });

  it('protects the rollup when a bright day is followed by a weaker one', () => {
    // This is the case that actually corrupts MAX(dailyEnergy) GROUP BY localDate.
    const t = new DailyCounterTracker();
    t.resolve('2026-07-24', 109900); // a big day
    const stored = [
      t.resolve('2026-07-25', 109900), // carryover — must not become today's max
      t.resolve('2026-07-25', 0), // reset
      t.resolve('2026-07-25', 4200),
      t.resolve('2026-07-25', 40000), // a weaker day
    ];
    expect(Math.max(...stored)).toBe(40000); // not 109900
  });

  it('passes a clean midnight straight through', () => {
    const t = new DailyCounterTracker();
    t.resolve('2026-07-25', 108000);
    // Counter reset before the date flipped — nothing to suppress.
    expect(t.resolve('2026-07-25', 0)).toBe(0);
    expect(t.resolve('2026-07-26', 0)).toBe(0);
    expect(t.resolve('2026-07-26', 250)).toBe(250);
    expect(t.carryingOver).toBe(false);
  });

  it('seeds from stored state so a restart mid-carryover still suppresses', () => {
    const t = new DailyCounterTracker();
    t.seed('2026-07-23', 39985); // last row before the process restarted
    expect(t.resolve('2026-07-24', 39985)).toBe(0);
  });

  it('documents that the counter decays after sunset within the same day', () => {
    // Real sequence observed 2026-07-26 evening, all at 0 W and all the same local
    // date: the gateway does NOT hold the day's total once production stops.
    //   109334 -> 44348 -> 6338
    // The tracker deliberately passes these through — they are an honest record of
    // what the device reported — so anything presenting "today" must take the day's
    // MAX, not the newest reading. Taking the newest showed $1.01 for a 108 kWh day.
    const t = new DailyCounterTracker();
    const stored = [
      t.resolve('2026-07-26', 109334),
      t.resolve('2026-07-26', 44348),
      t.resolve('2026-07-26', 6338),
    ];
    expect(stored).toEqual([109334, 44348, 6338]);
    expect(Math.max(...stored)).toBe(109334); // the day's real total
    expect(t.carryingOver).toBe(false); // not a date-boundary carryover
  });

  it('does not suppress when the previous day ended at zero', () => {
    const t = new DailyCounterTracker();
    t.resolve('2026-07-23', 0);
    expect(t.resolve('2026-07-24', 0)).toBe(0);
    expect(t.resolve('2026-07-24', 800)).toBe(800);
    expect(t.carryingOver).toBe(false);
  });
});
