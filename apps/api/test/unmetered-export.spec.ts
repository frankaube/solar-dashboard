import { describe, expect, it } from 'vitest';
import { evaluateUnmeteredExport } from '../src/alerts/unmetered-export';

/*
  The distinction this rule draws: unmetered days that have ended are history, unmetered days
  still running are money leaving the property now. Only the second is an alert.
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
    // Net metering activated on the 27th: the earlier days are still worth pricing, but
    // they are not a fault anyone can act on.
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
    // A published usage export lags by weeks, so windowing against now goes quiet while the
    // fault is still running and merely unpublished.
    const alerts = evaluateUnmeteredExport({
      newestDate: '2025-01-15', // a year stale, and the last thing it said was "not counting"
      unmetered: [{ date: '2025-01-15', producedKwh: 40 }],
    });
    expect(alerts).toHaveLength(1);
    // Dated rather than tenseless, so a stale claim cannot read as a fresh one.
    expect(alerts[0].message).toContain('2025-01-15');
  });

  it('drops the figure rather than announcing a giveaway of nothing', () => {
    // Production comes from the rollup, which does not reach back forever, and a lifetime-
    // accumulator source reports zero regardless. The day was flagged because production
    // existed, so zero here means unknown, not none.
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
    // Only reachable through a corrupt import, and it would report a fault from data that
    // does not exist.
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
