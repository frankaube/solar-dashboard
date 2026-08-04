import { describe, expect, it } from 'vitest';
import { MIN_SAMPLES, MONTHS_FOR_A_RATE, assessDegradation } from '../src/readings/degradation';

/*
  The load-bearing behaviour here is the refusal.

  A month of snapshots fits a line, and that line has a slope, and the slope is enormous
  and meaningless — seasonal sun angle moves this ratio far more than ageing does over any
  short window. Reporting it would print "degrading 40% per year" from noise, in the same
  typeface as a real measurement.
*/

const month = (index: number): string => {
  const year = 2026 + Math.floor(index / 12);
  return `${year}-${String((index % 12) + 1).padStart(2, '0')}`;
};

/** A record of `count` months whose response falls by `pctPerYear`. */
const record = (count: number, pctPerYear: number, start = 40): Array<{ month: string; wattsPerIrradiance: number; samples: number }> =>
  Array.from({ length: count }, (_, i) => ({
    month: month(i),
    wattsPerIrradiance: start * (1 + (pctPerYear / 100) * (i / 12)),
    samples: 900,
  }));

describe('before there is enough history', () => {
  it('says nothing at all with no usable months', () => {
    const result = assessDegradation([]);
    expect(result.annualChangePct).toBeNull();
    expect(result.monthsRecorded).toBe(0);
    expect(result.summary).toMatch(/No month has recorded enough/);
  });

  it('refuses a rate after one month, and says how much longer', () => {
    const result = assessDegradation(record(1, -0.5));
    expect(result.annualChangePct).toBeNull();
    expect(result.monthsRecorded).toBe(1);
    expect(result.summary).toMatch(/23 more/);
    expect(result.summary).toMatch(/measuring the calendar/);
  });

  it('still refuses at one year', () => {
    /*
      A single year cannot separate ageing from the seasonal cycle — the fit would be
      measuring where in the year the record happens to start and end.
    */
    const result = assessDegradation(record(12, -0.5));
    expect(result.annualChangePct).toBeNull();
    expect(result.monthsNeeded).toBe(MONTHS_FOR_A_RATE);
  });

  it('counts the span, not the number of rows', () => {
    // A gap in the middle does not make the record shorter than it is.
    const sparse = [
      { month: '2026-01', wattsPerIrradiance: 40, samples: 900 },
      { month: '2027-12', wattsPerIrradiance: 39.6, samples: 900 },
    ];
    expect(assessDegradation(sparse).monthsRecorded).toBe(24);
  });
});

describe('once the record is long enough', () => {
  it('measures a real decline', () => {
    const result = assessDegradation(record(24, -0.5));
    expect(result.annualChangePct).toBeCloseTo(-0.5, 1);
    expect(result.summary).toMatch(/losing about 0\.5\d?% of its output per year/);
  });

  it('calls a flat array flat rather than finding a trend in rounding', () => {
    const result = assessDegradation(record(24, 0));
    expect(result.annualChangePct).toBeCloseTo(0, 2);
    expect(result.summary).toMatch(/no measurable change/);
  });

  it('does not congratulate an array on improving', () => {
    /*
      Panels do not get better. A positive slope is a cleaning, a repair, or a change in
      what the weather source reports — and saying so is more useful than a cheerful number.
    */
    const result = assessDegradation(record(24, 1.5));
    expect(result.annualChangePct).toBeGreaterThan(0);
    expect(result.summary).toMatch(/not something panels do/);
    expect(result.summary).toMatch(/cleaning/);
  });
});

describe('what counts as a usable month', () => {
  it('drops a month with too little sun behind it', () => {
    /*
      A median over a handful of dim readings is not a weak measurement of the array's
      response. It is a measurement of something else, and averaging it in corrupts the
      series rather than adding noise to it.
    */
    const thin = record(24, -0.5).map((s, i) => (i === 5 ? { ...s, samples: MIN_SAMPLES - 1 } : s));
    expect(assessDegradation(thin).snapshots).toHaveLength(23);
  });

  it('ignores a zero or negative response', () => {
    const broken = [
      ...record(24, -0.5),
      { month: '2028-01', wattsPerIrradiance: 0, samples: 900 },
    ];
    expect(assessDegradation(broken).snapshots.every((s) => s.wattsPerIrradiance > 0)).toBe(true);
  });

  it('sorts a record that arrives out of order', () => {
    const shuffled = [...record(24, -0.5)].reverse();
    const result = assessDegradation(shuffled);
    expect(result.snapshots[0].month).toBe('2026-01');
    expect(result.annualChangePct).toBeCloseTo(-0.5, 1);
  });
});
