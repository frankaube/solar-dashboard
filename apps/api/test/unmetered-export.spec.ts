import { describe, expect, it } from 'vitest';
import { evaluateUnmeteredExport } from '../src/alerts/unmetered-export';

/*
  The distinction this rule exists to draw: four unmetered days that ended in July are
  history, and four that are still running are money leaving the property this week. The
  Savings page used to state both in the same sentence, which is why it said nothing.
*/

describe('evaluateUnmeteredExport', () => {
  it('fires while the meter is still not counting', () => {
    const alerts = evaluateUnmeteredExport({
      newestDate: '2026-07-26',
      unmetered: [
        { date: '2026-07-23', producedKwh: 90 },
        { date: '2026-07-24', producedKwh: 85 },
        { date: '2026-07-25', producedKwh: 83 },
        { date: '2026-07-26', producedKwh: 109.3 },
      ],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('serious');
    expect(alerts[0].message).toContain('367.3 kWh');
    expect(alerts[0].message).toContain('2026-07-23');
  });

  it('stays quiet once normal readings follow the gap', () => {
    /*
      This install's real shape: the utility activated net metering on the 27th and the
      meter has counted every day since. The four days before it are still worth seeing —
      priced on the credit card — but they are not a fault anyone can still act on.
    */
    const alerts = evaluateUnmeteredExport({
      newestDate: '2026-08-02',
      unmetered: [
        { date: '2026-07-23', producedKwh: 90 },
        { date: '2026-07-24', producedKwh: 85 },
        { date: '2026-07-25', producedKwh: 83 },
        { date: '2026-07-26', producedKwh: 109.3 },
      ],
    });
    expect(alerts).toEqual([]);
  });

  it('measures the window from the newest reading, not from today', () => {
    /*
      A published usage export always lags by weeks. Windowing against now would go quiet
      during exactly the period when the fault is still running and simply unpublished —
      the app would fall silent because it was behind, not because anything improved.
    */
    const alerts = evaluateUnmeteredExport({
      newestDate: '2025-01-15', // a year stale, and the last thing it said was "not counting"
      unmetered: [{ date: '2025-01-15', producedKwh: 40 }],
    });
    expect(alerts).toHaveLength(1);
    // Dated rather than tenseless, so a stale claim cannot read as a fresh one.
    expect(alerts[0].message).toContain('2025-01-15');
  });

  it('drops the figure rather than announcing a giveaway of nothing', () => {
    /*
      Production is looked up from the rollup, which does not reach back forever — and a
      source publishing only a lifetime accumulator reports zero there regardless. The day
      was flagged because production existed, so zero here means unknown, not none.
    */
    const alerts = evaluateUnmeteredExport({
      newestDate: '2026-08-02',
      unmetered: [{ date: '2026-08-02', producedKwh: 0 }],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain('though the array was producing');
    expect(alerts[0].message).not.toContain('0 kWh');
  });

  it('says nothing when nothing has been imported', () => {
    expect(evaluateUnmeteredExport({ newestDate: null, unmetered: [] })).toEqual([]);
    expect(evaluateUnmeteredExport({ newestDate: '2026-08-02', unmetered: [] })).toEqual([]);
  });

  it('ignores a day dated after the newest reading', () => {
    // Only reachable through a corrupt import, but it would otherwise report a fault
    // from data that does not exist.
    const alerts = evaluateUnmeteredExport({
      newestDate: '2026-08-02',
      unmetered: [{ date: '2026-09-09', producedKwh: 50 }],
    });
    expect(alerts).toEqual([]);
  });

  it('drops the range when only one day is involved', () => {
    const alerts = evaluateUnmeteredExport({
      newestDate: '2026-08-02',
      unmetered: [{ date: '2026-08-02', producedKwh: 61.5 }],
    });
    expect(alerts[0].message).toContain('1 of the days');
    expect(alerts[0].message).not.toContain('(from');
  });
});
