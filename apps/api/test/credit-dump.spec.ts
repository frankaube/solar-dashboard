import { describe, expect, it } from 'vitest';
import {
  MIN_TREND_DAYS,
  MIN_WORTH_MENTIONING_KWH,
  TREND_DAYS,
  averageChargeKw,
  dailyNet,
  planDump,
} from '../src/readings/credit-dump';

/*
  The deadline is the one number in this app with an obvious action attached: energy drawn
  before 31 March is free, energy drawn after it is bought. So the bar is not "is the
  projection interesting" but "would acting on it be right" — and every refusal below is a
  case where telling somebody to go and use electricity would have been wrong.
*/

const NOW = new Date('2026-03-01T12:00:00Z');
const EXPIRY = new Date('2026-03-31T00:00:00Z');
const RATE = 0.13383;

/** `count` days ending the day before `NOW`, each with the same net. */
const days = (count: number, importedKwh: number, exportedKwh: number, unmetered = false) =>
  Array.from({ length: count }, (_, i) => {
    const at = new Date(NOW.getTime() - (count - i) * 86_400_000);
    return { date: at.toISOString().slice(0, 10), importedKwh, exportedKwh, unmetered };
  });

describe('dailyNet', () => {
  it('averages the net over the trend window', () => {
    // 20 exported against 10 imported = +10 a day.
    expect(dailyNet(days(14, 10, 20), NOW).rate).toBeCloseTo(10, 5);
  });

  it('refuses a trend from too few days', () => {
    const result = dailyNet(days(MIN_TREND_DAYS - 1, 10, 20), NOW);
    expect(result.rate).toBeNull();
    expect(result.days).toBe(MIN_TREND_DAYS - 1);
  });

  it('ignores days older than the window', () => {
    const old = [
      { date: '2025-06-01', importedKwh: 0, exportedKwh: 500 },
      ...days(10, 10, 20),
    ];
    // The ancient outlier would drag the average to ~55 if it counted.
    expect(dailyNet(old, NOW).rate).toBeCloseTo(10, 5);
  });

  it('excludes unmetered days rather than reading them as heavy import', () => {
    /*
      A day the meter recorded no export while the array produced nets out as pure import.
      Counted, it makes the bank look like it is draining faster than it is — wrong in the
      exact direction that would tell somebody to stop dumping when they should carry on.
    */
    const mixed = [...days(10, 10, 20), ...days(4, 80, 0, true)];
    expect(dailyNet(mixed, NOW).rate).toBeCloseTo(10, 5);
  });
});

describe('averageChargeKw', () => {
  it('measures rather than assuming somebody else s charger', () => {
    const kw = averageChargeKw([
      { startedAt: '2026-02-01T00:00:00Z', endedAt: '2026-02-01T02:00:00Z', energyWh: 14_000 },
    ]);
    expect(kw).toBeCloseTo(7, 5);
  });

  it('skips a plug-in too short to divide by', () => {
    // Ninety seconds that drew almost nothing produces a division saying 40 kW.
    const kw = averageChargeKw([
      { startedAt: '2026-02-01T00:00:00Z', endedAt: '2026-02-01T00:01:30Z', energyWh: 1_000 },
      { startedAt: '2026-02-02T00:00:00Z', endedAt: '2026-02-02T02:00:00Z', energyWh: 14_000 },
    ]);
    expect(kw).toBeCloseTo(7, 5);
  });

  it('has no answer with nothing to measure', () => {
    expect(averageChargeKw([])).toBeNull();
  });
});

describe('planDump', () => {
  const base = { expiresAt: EXPIRY, now: NOW, redeemRatePerKwh: RATE };

  it('projects the balance forward and says what draw would absorb it', () => {
    const plan = planDump({
      ...base,
      balanceKwh: 400,
      meterDays: days(14, 10, 20), // +10 kWh a day
      averageChargeKw: 7,
    });
    // 30 days to expiry at +10 a day on top of 400 → 700 kWh forfeited.
    expect(plan.atRiskKwh).toBeCloseTo(700, 0);
    expect(plan.atRiskValue).toBeCloseTo(700 * RATE, 1);
    expect(plan.dumpKwhPerDay).toBeCloseTo(700 / 30, 0);
    expect(plan.dumpHoursPerDay).toBeCloseTo(700 / 30 / 7, 0);
    expect(plan.actionable).toBe(true);
  });

  it('will not plan without a balance', () => {
    /*
      A rate says which way the bank is going, never how much is in it. Advising a dump off
      a trend alone would be telling somebody to spend money against a number nobody knows.
    */
    const plan = planDump({ ...base, balanceKwh: null, meterDays: days(14, 10, 20) });
    expect(plan.actionable).toBe(false);
    expect(plan.atRiskKwh).toBeNull();
    expect(plan.reason).toMatch(/bill/i);
  });

  it('will not plan without enough meter data', () => {
    const plan = planDump({ ...base, balanceKwh: 400, meterDays: days(3, 10, 20) });
    expect(plan.actionable).toBe(false);
    expect(plan.reason).toContain(String(TREND_DAYS));
  });

  it('says nothing when the bank is on track to empty itself', () => {
    // Drawing down 20 a day for 30 days clears a 400 kWh bank with room to spare.
    const plan = planDump({ ...base, balanceKwh: 400, meterDays: days(14, 30, 10) });
    expect(plan.actionable).toBe(false);
    expect(plan.atRiskKwh).toBe(0);
    expect(plan.reason).toMatch(/on track/i);
  });

  it('stays quiet about an amount the error bars swallow', () => {
    /*
      A projection is not accurate to the kilowatt-hour. Telling somebody to go and use
      three of them spends their attention on nothing.
    */
    const plan = planDump({ ...base, balanceKwh: 10, meterDays: days(14, 20, 20) });
    expect(plan.atRiskKwh).toBeLessThan(MIN_WORTH_MENTIONING_KWH);
    expect(plan.actionable).toBe(false);
  });

  it('still reports hours as null when no charging has been seen', () => {
    const plan = planDump({
      ...base,
      balanceKwh: 400,
      meterDays: days(14, 10, 20),
      averageChargeKw: null,
    });
    expect(plan.actionable).toBe(true);
    expect(plan.dumpKwhPerDay).not.toBeNull();
    // The kWh advice stands on its own; the hours are a convenience that needs a charger.
    expect(plan.dumpHoursPerDay).toBeNull();
  });

  it('does not divide by zero on the expiry date itself', () => {
    const plan = planDump({
      ...base,
      now: EXPIRY,
      balanceKwh: 400,
      meterDays: days(14, 10, 20),
    });
    expect(plan.daysRemaining).toBe(0);
    expect(Number.isFinite(plan.dumpKwhPerDay ?? 0)).toBe(true);
  });
});
