import { describe, expect, it } from 'vitest';
import { ClipSample, detectClipping } from '../src/readings/clipping';

/*
  The detector must stay quiet on a healthy array. The real array measured 94.81% conversion
  at every DC band from 600 W to 1500 W — that flat line is the healthy shape; clipping is
  that line breaking at the top and only at the top.
*/

const MINUTE = 60_000;
const START = Date.parse('2026-08-01T10:00:00Z');

/**
 * A day's worth of samples following a sine, which is what a clear day looks like.
 *
 * Sinusoidal rather than a uniform sweep: output piles up near the peak on any clear day,
 * and a linear generator would not exercise the pile-up a detector can mistake for a ceiling.
 */
function clearDay(options: {
  peakDcW: number;
  efficiency: number;
  /** AC ceiling, or null for an unclipped unit. */
  ceilingAcW?: number | null;
  samples?: number;
}): ClipSample[] {
  const { peakDcW, efficiency, ceilingAcW = null, samples = 600 } = options;
  const out: ClipSample[] = [];
  for (let i = 0; i < samples; i++) {
    const dcW = peakDcW * Math.sin((Math.PI * (i + 0.5)) / samples);
    const uncapped = dcW * efficiency;
    out.push({
      at: START + i * 5 * MINUTE,
      dcW,
      acW: ceilingAcW === null ? uncapped : Math.min(uncapped, ceilingAcW),
    });
  }
  return out;
}

describe('a healthy inverter', () => {
  it('says nothing about a clear day that merely plateaus near its peak', () => {
    // Time-at-power diverges at the top of a sine, so the top histogram bucket is crowded
    // whether or not anything is clipping.
    expect(detectClipping(clearDay({ peakDcW: 1549, efficiency: 0.9481 }))).toBeNull();
  });

  it('stays silent on the real array’s measured numbers', () => {
    // 1549 W peak DC, 94.81% conversion, no ceiling reached — August 2026, ten 4-port units.
    expect(detectClipping(clearDay({ peakDcW: 1549, efficiency: 0.9481 }))).toBeNull();
  });

  it('stays silent on a single-panel unit too', () => {
    // Bands are a share of each unit's own peak, so 387 W behaves like 1549 W.
    expect(detectClipping(clearDay({ peakDcW: 387, efficiency: 0.9481 }))).toBeNull();
  });

  it('is not fooled by a unit that is simply less efficient', () => {
    // A flat 88% is a different inverter, not a clipped one. Flat is flat.
    expect(detectClipping(clearDay({ peakDcW: 1549, efficiency: 0.88 }))).toBeNull();
  });

  it('says nothing when there is barely any data', () => {
    expect(detectClipping(clearDay({ peakDcW: 1549, efficiency: 0.9481, samples: 20 }))).toBeNull();
  });

  it('says nothing about a unit that never woke up', () => {
    const dark = Array.from({ length: 300 }, (_, i) => ({ at: START + i * MINUTE, dcW: 0, acW: 0 }));
    expect(detectClipping(dark)).toBeNull();
  });
});

describe('a clipped inverter', () => {
  /** 1600 W AC on the same panels — the cold bright spring day case. */
  const clipped = clearDay({ peakDcW: 1900, efficiency: 0.9481, ceilingAcW: 1600 });

  it('finds the ceiling', () => {
    const found = detectClipping(clipped);
    expect(found).not.toBeNull();
    expect(found!.ceilingAcW).toBeCloseTo(1600, 0);
  });

  it('reports the plateau it broke away from', () => {
    const found = detectClipping(clipped)!;
    expect(found.plateauEfficiency).toBeCloseTo(0.9481, 3);
    expect(found.topEfficiency).toBeLessThan(found.plateauEfficiency - 0.02);
  });

  it('counts the samples spent against the ceiling', () => {
    expect(detectClipping(clipped)!.clippedSamples).toBeGreaterThan(20);
  });

  it('puts a number on what it costs', () => {
    // Bounded rather than exact: the figure depends on sample spacing, so pinning it would
    // test the fixture.
    const lost = detectClipping(clipped)!.lostWhPerDay;
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan(2000);
  });

  it('says when it happened', () => {
    const found = detectClipping(clipped)!;
    expect(found.firstAt).toBeGreaterThanOrEqual(START);
    expect(found.lastAt).toBeGreaterThan(found.firstAt);
  });

  it('finds a hard ceiling as readily as a soft one', () => {
    const hard = clearDay({ peakDcW: 2400, efficiency: 0.9481, ceilingAcW: 1600 });
    expect(detectClipping(hard)!.ceilingAcW).toBeCloseTo(1600, 0);
  });

  it('ignores a ceiling so high nothing ever reaches it', () => {
    // A 2000 W limit on panels that peak at 1469 W AC is not a finding.
    expect(detectClipping(clearDay({ peakDcW: 1549, efficiency: 0.9481, ceilingAcW: 2000 }))).toBeNull();
  });
});

describe('the loss estimate', () => {
  it('does not invent energy across a long gap in the data', () => {
    // Readings are stored on change or on a heartbeat, so a quiet stretch leaves hours
    // between rows; one clipped sample must not be credited with the whole gap.
    const dense = clearDay({ peakDcW: 1900, efficiency: 0.9481, ceilingAcW: 1600 });
    const sparse = dense.map((s, i) => ({ ...s, at: s.at + (i > 300 ? 6 * 3_600_000 : 0) }));
    const a = detectClipping(dense)!.lostWhPerDay;
    const b = detectClipping(sparse)!.lostWhPerDay;
    // The gap must not multiply the loss; if anything it dilutes it across a longer window.
    expect(b).toBeLessThanOrEqual(a);
  });

  it('is not changed by how often the meter happened to sample', () => {
    // Same day, same clipping, half the rows. Storage is on change or on a heartbeat, so
    // density genuinely varies through a day; the per-day figure must not move with it.
    const dense = clearDay({ peakDcW: 1900, efficiency: 0.9481, ceilingAcW: 1600, samples: 600 });
    const sparse = dense
      .filter((_, i) => i % 2 === 0)
      .map((s, i) => ({ ...s, at: START + i * 10 * MINUTE }));
    const a = detectClipping(dense)!.lostWhPerDay;
    const b = detectClipping(sparse)!.lostWhPerDay;
    expect(Math.abs(a - b) / a).toBeLessThan(0.05);
  });

  it('averages over the whole window, not just the days that clipped', () => {
    // Clipping is seasonal — a handful of cold bright days a year. Dividing only by the days
    // it happened would overstate the yearly cost several times over.
    const DAY_MS = 86_400_000;
    const day = clearDay({ peakDcW: 1900, efficiency: 0.9481, ceilingAcW: 1600 });
    // Six ordinary days after it: cooler, lower peak, nothing near the ceiling.
    const quiet = Array.from({ length: 6 }, (_, d) =>
      clearDay({ peakDcW: 1400, efficiency: 0.9481, samples: 200 }).map((s) => ({
        ...s,
        at: s.at + (d + 1) * DAY_MS,
      })),
    ).flat();

    const alone = detectClipping(day)!.lostWhPerDay;
    const overAWeek = detectClipping([...day, ...quiet])!.lostWhPerDay;
    expect(overAWeek).toBeLessThan(alone / 3);
  });
});
