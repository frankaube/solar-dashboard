import { describe, expect, it } from 'vitest';
import { mergePeriods } from '../src/pages/SavingsPage';
import type { SavingsPeriod } from '../src/api';

/**
 * First tests in the web app. The API had 233 and the frontend none, which meant every
 * bug in here was found by looking at it — and several were: an estimate rendering
 * like a measurement, a stale refresh, unknowns drawn as zeros.
 *
 * Starting with the period merge because it has real branching and a failure mode that
 * only appears on a young install, which is exactly when nobody is looking.
 */
const period = (producedKwh: number, realizedSaved: number): SavingsPeriod =>
  ({
    producedKwh,
    selfConsumedKwh: 0,
    exportedKwh: producedKwh,
    grossValue: 0,
    netMeteringValue: 0,
    bonusCaptured: 0,
    realizedSaved,
    bonusForegone: 0,
    selfConsumptionPct: 0,
  }) as SavingsPeriod;

const rows = (
  today: SavingsPeriod,
  month: SavingsPeriod,
  year: SavingsPeriod,
  lifetime: SavingsPeriod,
) => [
  { label: 'Today', short: 'today', p: today },
  { label: 'This month', short: 'month', p: month },
  { label: 'This year', short: 'year', p: year },
  { label: 'Lifetime', short: 'lifetime', p: lifetime },
];

describe('mergePeriods', () => {
  it('collapses identical consecutive periods into one row', () => {
    // On a system less than a month old these are genuinely the same number, and
    // printing it three times reads as a rendering bug rather than as the fact it is.
    const same = period(376.6, 52.5);
    const out = mergePeriods(rows(period(9.3, 1.29), same, same, same));
    expect(out).toHaveLength(2);
    expect(out[1].label).toBe('This month · year · lifetime');
  });

  it('keeps periods separate once they diverge', () => {
    // The merge must stop being clever the moment the numbers differ, or a mature
    // install would have its year folded into its lifetime.
    const out = mergePeriods(
      rows(period(9, 1), period(300, 40), period(4000, 500), period(9000, 1200)),
    );
    expect(out.map((r) => r.label)).toEqual(['Today', 'This month', 'This year', 'Lifetime']);
  });

  it('merges only adjacent matches, not any two that happen to agree', () => {
    // Today coinciding with lifetime is a coincidence, not a reason to join labels
    // across the periods in between.
    const coincidence = period(100, 10);
    const out = mergePeriods(
      rows(coincidence, period(200, 20), period(300, 30), coincidence),
    );
    expect(out).toHaveLength(4);
  });

  it('treats a difference in either figure as a difference', () => {
    // Same energy but different money — a rate change mid-year would do this — must
    // not be collapsed, because the money column would then be wrong for one of them.
    const a = period(376.6, 52.5);
    const b = period(376.6, 60.0);
    const out = mergePeriods(rows(period(9, 1), a, b, b));
    expect(out.map((r) => r.label)).toEqual(['Today', 'This month', 'This year · lifetime']);
  });

  it('merges everything on a brand-new install', () => {
    // Day one: today IS the month IS the year IS all of it.
    const all = period(9.3, 1.29);
    const out = mergePeriods(rows(all, all, all, all));
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Today · month · year · lifetime');
  });

  it('handles a system that has produced nothing at all', () => {
    const zero = period(0, 0);
    expect(mergePeriods(rows(zero, zero, zero, zero))).toHaveLength(1);
  });

  it('does not mutate the rows it was given', () => {
    // It builds labels by appending, and appending to the caller's object would
    // corrupt the next render.
    const same = period(376.6, 52.5);
    const input = rows(period(9.3, 1.29), same, same, same);
    mergePeriods(input);
    expect(input.map((r) => r.label)).toEqual(['Today', 'This month', 'This year', 'Lifetime']);
  });
});
