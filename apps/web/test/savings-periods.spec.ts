import { describe, expect, it } from 'vitest';
import { mergePeriods, selfConsumptionBasis } from '../src/pages/SavingsPage';
import type { SavingsPeriod } from '../src/api';

/** The period merge: its failure mode only appears on a young install. */
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
    const same = period(376.6, 52.5);
    const out = mergePeriods(rows(period(9.3, 1.29), same, same, same));
    expect(out).toHaveLength(2);
    expect(out[1].label).toBe('This month · year · lifetime');
  });

  it('keeps periods separate once they diverge', () => {
    const out = mergePeriods(
      rows(period(9, 1), period(300, 40), period(4000, 500), period(9000, 1200)),
    );
    expect(out.map((r) => r.label)).toEqual(['Today', 'This month', 'This year', 'Lifetime']);
  });

  it('merges only adjacent matches, not any two that happen to agree', () => {
    const coincidence = period(100, 10);
    const out = mergePeriods(
      rows(coincidence, period(200, 20), period(300, 30), coincidence),
    );
    expect(out).toHaveLength(4);
  });

  it('treats a difference in either figure as a difference', () => {
    // Same energy, different money — a mid-year rate change does this.
    const a = period(376.6, 52.5);
    const b = period(376.6, 60.0);
    const out = mergePeriods(rows(period(9, 1), a, b, b));
    expect(out.map((r) => r.label)).toEqual(['Today', 'This month', 'This year · lifetime']);
  });

  it('merges everything on a brand-new install', () => {
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
    // It builds labels by appending; mutating the caller's rows corrupts the next render.
    const same = period(376.6, 52.5);
    const input = rows(period(9.3, 1.29), same, same, same);
    mergePeriods(input);
    expect(input.map((r) => r.label)).toEqual(['Today', 'This month', 'This year', 'Lifetime']);
  });
});

describe('selfConsumptionBasis', () => {
  const p = (
    producedKwh: number,
    measuredProducedKwh: number,
    selfConsumptionEstimated: boolean,
  ): SavingsPeriod =>
    ({ producedKwh, measuredProducedKwh, selfConsumptionEstimated }) as SavingsPeriod;

  it('says so plainly when the whole period was measured', () => {
    const text = selfConsumptionBasis(p(500, 500, false));
    expect(text).toContain('Measured at the meter');
    expect(text).not.toContain('estimated in Settings');
  });

  it('names the share when a period is part measured and part not', () => {
    // A published usage export lags by weeks, so part-measured is the normal condition and
    // a single flag cannot express it.
    const text = selfConsumptionBasis(p(981, 613, true));
    expect(text).toContain('613 kWh of 981 kWh');
    expect(text).toContain('62%');
    expect(text).toContain('publishes in arrears');
  });

  it('says what to do about it when nothing was measured', () => {
    const text = selfConsumptionBasis(p(981, 0, true));
    expect(text).toContain('estimated in Settings');
    expect(text).toContain('utility usage export');
  });

  it('does not divide by zero on a period that produced nothing', () => {
    expect(() => selfConsumptionBasis(p(0, 0, true))).not.toThrow();
  });

  it('survives a payload from a version that had no such field', () => {
    // A tab left open across an update polls the new API with the old bundle, and vice versa.
    expect(() => selfConsumptionBasis({ producedKwh: 100, selfConsumptionEstimated: true } as SavingsPeriod)).not.toThrow();
  });
});

describe('selfConsumptionBasis on an install that already imports', () => {
  const bare = (producedKwh: number, measuredProducedKwh: number): SavingsPeriod =>
    ({ producedKwh, measuredProducedKwh, selfConsumptionEstimated: true }) as SavingsPeriod;

  it('does not tell someone to import a file they have already imported', () => {
    // The utility publishes in arrears, so on an install that imports monthly the newest
    // days are always the estimated ones.
    const text = selfConsumptionBasis(bare(66, 0), true);
    expect(text).toContain('publishes in arrears');
    expect(text).not.toContain('Import your utility usage export');
  });

  it('still says what to do when nothing has ever been measured', () => {
    expect(selfConsumptionBasis(bare(981, 0), false)).toContain('Import your utility usage export');
  });
});
