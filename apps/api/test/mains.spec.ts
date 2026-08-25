import { describe, expect, it } from 'vitest';
import { MAX_SAMPLE_GAP_MS, integrateMains, selfConsumedFromMains } from '../src/readings/mains';

/*
  The sign is the measurement: -4,000 W is selling four kilowatts, +4,000 W is buying them.
  An absolute value anywhere here discards that and still yields plausible-looking totals.
*/

const at = (iso: string): Date => new Date(iso);
/** Local date is the UTC date in these fixtures — the real one is injected by the caller. */
const localDateOf = (date: Date): string => date.toISOString().slice(0, 10);

const series = (points: Array<[string, number]>) =>
  points.map(([iso, powerW]) => ({ takenAt: at(iso), powerW }));

describe('integrateMains', () => {
  it('integrates a steady import', () => {
    // 1200 W for one hour.
    const totals = integrateMains(
      series([['2026-08-04T10:00:00Z', 1200], ['2026-08-04T10:05:00Z', 1200]]),
      localDateOf,
    );
    expect(totals.get('2026-08-04')?.importedWh).toBeCloseTo(100, 6); // 5 minutes of 1200 W
    expect(totals.get('2026-08-04')?.exportedWh).toBe(0);
  });

  it('reads negative power as export, not as consumption', () => {
    const totals = integrateMains(
      series([['2026-08-04T13:00:00Z', -6000], ['2026-08-04T13:05:00Z', -6000]]),
      localDateOf,
    );
    expect(totals.get('2026-08-04')?.exportedWh).toBeCloseTo(500, 6);
    expect(totals.get('2026-08-04')?.importedWh).toBe(0);
  });

  it('splits an interval that crosses zero instead of dumping it in one bucket', () => {
    // Assigning a straddling interval whole to one side biases both totals invisibly.
    const totals = integrateMains(
      series([['2026-08-04T17:00:00Z', -1000], ['2026-08-04T17:10:00Z', 1000]]),
      localDateOf,
    );
    const day = totals.get('2026-08-04');
    // Symmetric crossing: half the interval each side, each a triangle.
    expect(day?.exportedWh).toBeCloseTo(41.67, 1);
    expect(day?.importedWh).toBeCloseTo(41.67, 1);
  });

  it('refuses to credit a gap in the record', () => {
    // A meter off the network for an hour must not have that hour credited at whatever it
    // was reading when it left.
    const totals = integrateMains(
      series([
        ['2026-08-04T10:00:00Z', 3000],
        [`2026-08-04T${new Date(Date.parse('2026-08-04T10:00:00Z') + MAX_SAMPLE_GAP_MS + 60_000).toISOString().slice(11, 19)}Z`, 3000],
      ]),
      localDateOf,
    );
    expect(totals.size).toBe(0);
  });

  it('attributes an interval to the day it started', () => {
    // Splitting at midnight would be more precise and would disagree with how production
    // is bucketed. Two totals disagreeing about where a day ends is the worse failure.
    const totals = integrateMains(
      series([['2026-08-04T23:58:00Z', 600], ['2026-08-05T00:02:00Z', 600]]),
      localDateOf,
    );
    expect(totals.get('2026-08-04')?.importedWh).toBeCloseTo(40, 6);
    expect(totals.has('2026-08-05')).toBe(false);
  });

  it('sorts samples that arrive out of order', () => {
    const totals = integrateMains(
      series([['2026-08-04T10:05:00Z', 1200], ['2026-08-04T10:00:00Z', 1200]]),
      localDateOf,
    );
    expect(totals.get('2026-08-04')?.importedWh).toBeCloseTo(100, 6);
  });

  it('ignores unusable readings rather than treating them as zero', () => {
    const totals = integrateMains(
      [
        { takenAt: at('2026-08-04T10:00:00Z'), powerW: Number.NaN },
        { takenAt: at('2026-08-04T10:05:00Z'), powerW: 1200 },
      ],
      localDateOf,
    );
    expect(totals.size).toBe(0);
  });

  it('needs two samples to have measured anything', () => {
    expect(integrateMains(series([['2026-08-04T10:00:00Z', 1200]]), localDateOf).size).toBe(0);
    expect(integrateMains([], localDateOf).size).toBe(0);
  });
});

describe('selfConsumedFromMains', () => {
  it('is what was made minus what left', () => {
    expect(selfConsumedFromMains(30_000, 21_000)).toBe(9_000);
  });

  it('keeps a real zero — a day that exported everything', () => {
    expect(selfConsumedFromMains(30_000, 30_000)).toBe(0);
  });

  it('clamps contradictory inputs to the nearest possible answer', () => {
    // Exporting more than was produced means the clamp is on a partial circuit, or
    // production covers a window the meter missed. Neither justifies a negative quantity.
    expect(selfConsumedFromMains(10_000, 25_000)).toBe(0);
    expect(selfConsumedFromMains(0, 5_000)).toBe(0);
    expect(selfConsumedFromMains(-5, 0)).toBe(0);
  });
});
