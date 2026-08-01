import { describe, expect, it } from 'vitest';
import {
  MAX_SAMPLE_GAP_MS,
  buildBuckets,
  integrateHourly,
  localParts,
  totalProduced,
} from '../src/readings/hourly-flows';

const TZ = 'Atlantic/Bermuda';

/** Samples every 5 minutes from a start instant, all at the same wattage. */
function series(startIso: string, watts: number, count: number, stepMs = 5 * 60_000) {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => ({
    takenAt: new Date(start + i * stepMs),
    watts,
  }));
}

/**
 * Local wall-clock, not UTC.
 *
 * A tariff's peak window is "4pm to 9pm" where the meter is. Bucketing in UTC would
 * shift every kWh by the offset — at UTC-3 that moves the whole evening peak
 * into the shoulder and understates a battery by roughly half.
 */
describe('localParts', () => {
  it('converts UTC to local wall-clock hours', () => {
    // 2026-07-15T18:00Z is 15:00 ADT (UTC-3).
    expect(localParts(new Date('2026-07-15T18:00:00Z'), TZ).hour).toBe(15);
  });

  it('tracks daylight saving rather than assuming a fixed offset', () => {
    // Same UTC hour, six months apart: ADT (UTC-3) in July, AST (UTC-4) in January.
    const summer = localParts(new Date('2026-07-15T18:00:00Z'), TZ).hour;
    const winter = localParts(new Date('2026-01-15T18:00:00Z'), TZ).hour;
    expect(summer).toBe(15);
    expect(winter).toBe(14);
  });

  it('reports midnight as hour 0, never 24', () => {
    // Some ICU builds render midnight as "24" under hour12:false.
    expect(localParts(new Date('2026-07-15T03:00:00Z'), TZ).hour).toBe(0);
  });

  it('reads month and weekday locally too', () => {
    // 2026-07-15 is a Wednesday.
    const parts = localParts(new Date('2026-07-15T18:00:00Z'), TZ);
    expect(parts.month).toBe(7);
    expect(parts.weekday).toBe(3);
  });

  it('puts an instant near midnight in the correct local day', () => {
    // 01:30Z on the 16th is 22:30 on the 15th locally — a Wednesday, not Thursday.
    const parts = localParts(new Date('2026-07-16T01:30:00Z'), TZ);
    expect(parts.hour).toBe(22);
    expect(parts.weekday).toBe(3);
  });
});

describe('integrateHourly', () => {
  it('turns constant watts into the right energy', () => {
    // 12 samples 5 min apart at 1200 W = 11 intervals x 5 min = 55 min at 1.2 kW.
    const kwh = [...integrateHourly(series('2026-07-15T16:00:00Z', 1200, 12), TZ).values()].reduce(
      (a, b) => a + b,
      0,
    );
    expect(kwh).toBeCloseTo(1.2 * (55 / 60), 6);
  });

  it('ignores a collector outage instead of integrating across it', () => {
    // Two samples a day apart would otherwise book 24 hours of production.
    const samples = [
      { takenAt: new Date('2026-07-15T16:00:00Z'), watts: 1000 },
      { takenAt: new Date('2026-07-16T16:00:00Z'), watts: 1000 },
    ];
    const kwh = [...integrateHourly(samples, TZ).values()].reduce((a, b) => a + b, 0);
    expect(kwh).toBeCloseTo((1000 * (MAX_SAMPLE_GAP_MS / 3_600_000)) / 1000, 9);
  });

  it('drops zero and negative watts by default', () => {
    const samples = series('2026-07-15T16:00:00Z', 0, 12);
    expect(integrateHourly(samples, TZ).size).toBe(0);
  });

  it('lets the caller select a sign, for battery discharge', () => {
    // Battery power is negative when discharging; only that side is self-consumption.
    const samples = [
      { takenAt: new Date('2026-07-15T22:00:00Z'), watts: -1000 },
      { takenAt: new Date('2026-07-15T23:00:00Z'), watts: 500 },
      { takenAt: new Date('2026-07-16T00:00:00Z'), watts: 0 },
    ];
    const discharge = integrateHourly(samples, TZ, (w) => -w);
    const total = [...discharge.values()].reduce((a, b) => a + b, 0);
    // Only the first interval discharges, capped at the max gap (10 min).
    expect(total).toBeCloseTo((1000 * (MAX_SAMPLE_GAP_MS / 3_600_000)) / 1000, 9);
  });

  it('separates hours, so a peak window can be told from a shoulder', () => {
    const samples = [
      ...series('2026-07-15T18:00:00Z', 2000, 12), // 15:00 local
      ...series('2026-07-15T20:00:00Z', 2000, 12), // 17:00 local — peak
    ];
    const byKey = integrateHourly(samples, TZ);
    const hours = [...byKey.keys()].map((k) => Number(k.split('|')[3]));
    expect(new Set(hours)).toEqual(new Set([15, 17]));
  });

  it('handles an empty or single-sample series', () => {
    expect(integrateHourly([], TZ).size).toBe(0);
    expect(integrateHourly(series('2026-07-15T16:00:00Z', 1000, 1), TZ).size).toBe(0);
  });

  it('ignores out-of-order samples rather than subtracting energy', () => {
    const samples = [
      { takenAt: new Date('2026-07-15T17:00:00Z'), watts: 1000 },
      { takenAt: new Date('2026-07-15T16:00:00Z'), watts: 1000 },
    ];
    expect(integrateHourly(samples, TZ).size).toBe(0);
  });
});

describe('buildBuckets', () => {
  it('splits production into self-consumed and exported', () => {
    const production = new Map([['2026-07-15|7|3|15', 10]]);
    const self = new Map([['2026-07-15|7|3|15', 4]]);
    const [bucket] = buildBuckets(production, self);
    expect(bucket).toMatchObject({ month: 7, weekday: 3, hour: 15, producedKwh: 10 });
    expect(bucket.selfConsumedKwh).toBe(4);
    expect(bucket.exportedKwh).toBe(6);
  });

  it('never lets self-consumption exceed production in an hour', () => {
    /*
      EV charging and battery discharge both happen on grid power at night. Counting
      those as solar would invent production — and under time-of-use it would invent
      it at the peak rate, which is the most expensive possible way to be wrong.
    */
    const [bucket] = buildBuckets(
      new Map([['2026-01-14|1|3|22', 0]]),
      new Map([['2026-01-14|1|3|22', 8]]),
    );
    expect(bucket.selfConsumedKwh).toBe(0);
    expect(bucket.exportedKwh).toBe(0);
  });

  it('keeps hours that only appear in one of the two series', () => {
    const buckets = buildBuckets(
      new Map([['2026-07-15|7|3|12', 5]]),
      new Map([['2026-07-15|7|3|22', 3]]),
    );
    expect(buckets).toHaveLength(2);
    expect(totalProduced(buckets)).toBe(5);
  });

  it('produces nothing from nothing', () => {
    expect(buildBuckets(new Map(), new Map())).toEqual([]);
  });
});

describe('period filtering', () => {
  const production = new Map([
    ['2026-07-15|7|3|12', 5],
    ['2026-07-16|7|4|12', 6],
    ['2026-06-10|6|3|12', 7],
  ]);

  it('selects one month without touching the rest', () => {
    const july = buildBuckets(production, new Map(), (d) => d.startsWith('2026-07'));
    expect(totalProduced(july)).toBe(11);
  });

  it('selects a single day', () => {
    const day = buildBuckets(production, new Map(), (d) => d === '2026-07-16');
    expect(totalProduced(day)).toBe(6);
  });

  it('defaults to everything, so lifetime needs no special case', () => {
    expect(totalProduced(buildBuckets(production, new Map()))).toBe(18);
  });

  it('returns nothing when the period has no data, rather than everything', () => {
    // An inverted filter is the kind of bug that silently reports lifetime as today.
    expect(buildBuckets(production, new Map(), (d) => d.startsWith('2020'))).toEqual([]);
  });
});
