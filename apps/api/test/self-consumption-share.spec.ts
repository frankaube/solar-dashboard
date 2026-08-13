import { describe, expect, it } from 'vitest';
import {
  MIN_DAYS,
  measuredSelfConsumptionShare,
} from '../src/readings/self-consumption-share';

/*
  This replaces the most load-bearing guess in the app — the share that decides how much
  unmetered production gets valued at the self-use rate rather than the export one. So it
  has to refuse before it guesses: the floor is one full week, because household load runs
  on a weekly cycle and five days is a biased slice of it rather than a smaller version.
*/

/** `count` days at a fixed production and self-consumption share. */
const days = (count: number, producedKwh: number, sharePct: number) =>
  Array.from({ length: count }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    producedKwh,
    exportedKwh: producedKwh * (1 - sharePct / 100),
  }));

describe('measuredSelfConsumptionShare', () => {
  it('measures the share this house actually ran at', () => {
    const share = measuredSelfConsumptionShare(days(20, 70, 31));
    expect(share.pct).toBeCloseTo(31, 1);
    expect(share.days).toBe(20);
    expect(share.reason).toBeNull();
  });

  it('refuses a figure from less than a full week, and says how many it wants', () => {
    const share = measuredSelfConsumptionShare(days(4, 70, 31));
    expect(share.pct).toBeNull();
    expect(share.reason).toContain(String(MIN_DAYS));
  });

  it('refuses when the days it has barely produced anything', () => {
    // A week of December is a week, and tells you nothing about a house's habits.
    const share = measuredSelfConsumptionShare(days(20, 3, 31));
    expect(share.pct).toBeNull();
    expect(share.reason).toContain('too little');
  });

  it('keeps a real zero — a house that exported everything', () => {
    const share = measuredSelfConsumptionShare(days(20, 70, 0));
    expect(share.pct).toBe(0);
    expect(share.reason).toBeNull();
  });

  it('clamps contradictory inputs to the nearest possible answer', () => {
    /*
      Exporting more than was produced means the two figures cover different windows. A
      share above unity would value more energy at the self-use rate than the array ever
      made — wrong in the expensive direction, and entirely plausible on screen.
    */
    const impossible = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      producedKwh: 50,
      exportedKwh: 90,
    }));
    expect(measuredSelfConsumptionShare(impossible).pct).toBe(0);
  });

  it('ignores days it cannot use rather than counting them as zero production', () => {
    const mixed = [
      ...days(20, 70, 31),
      { date: '2026-08-01', producedKwh: 0, exportedKwh: 0 },
      { date: '2026-08-02', producedKwh: Number.NaN, exportedKwh: 5 },
    ];
    const share = measuredSelfConsumptionShare(mixed);
    expect(share.days).toBe(20);
    expect(share.pct).toBeCloseTo(31, 1);
  });

  it('says nothing at all with nothing to measure', () => {
    const share = measuredSelfConsumptionShare([]);
    expect(share.pct).toBeNull();
    expect(share.days).toBe(0);
  });
});
