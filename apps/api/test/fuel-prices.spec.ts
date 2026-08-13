import { describe, expect, it } from 'vitest';
import {
  compareToGasoline,
  describeBasis,
  monthOf,
  priceForMonth,
} from '../src/charger/fuel-prices';

/*
  One city in the published series ran 130.0¢ to 191.1¢ inside eighteen months. A flat
  current price does not misprice an old drive slightly — it misprices it by half. These
  pin that each drive meets the price of its own month, and that where it cannot, the
  result says so rather than quietly asserting August cost what June cost.
*/

const localDateOf = (date: Date): string => date.toISOString().slice(0, 10);

/** Real figures from Statistics Canada, table 18-10-0001, regular unleaded self serve. */
const SERIES = [
  { month: '2026-01', centsPerLitre: 130.0 },
  { month: '2026-02', centsPerLitre: 134.7 },
  { month: '2026-03', centsPerLitre: 159.0 },
  { month: '2026-04', centsPerLitre: 178.3 },
  { month: '2026-05', centsPerLitre: 191.1 },
  { month: '2026-06', centsPerLitre: 172.6 },
];

const drive = (startedAt: string, distanceKm: number) => ({ startedAt, distanceKm, consumptionKwh: null });

describe('priceForMonth', () => {
  it('uses the month s own published figure when there is one', () => {
    expect(priceForMonth('2026-03', SERIES)).toEqual({
      centsPerLitre: 159.0,
      basis: 'published',
      from: '2026-03',
    });
  });

  it('carries the newest published price forward for a month not out yet', () => {
    // The series lags about six weeks, so recent drives always land here.
    expect(priceForMonth('2026-08', SERIES)).toEqual({
      centsPerLitre: 172.6,
      basis: 'carried-forward',
      from: '2026-06',
    });
  });

  it('refuses to reach backwards for a month older than the series', () => {
    /*
      Forwards and backwards are not the same approximation. The newest price is at least
      the closest one in time to a recent drive; the oldest is simply the furthest away
      from an old one, and using it would dress a guess as a measurement.
    */
    expect(priceForMonth('2024-11', SERIES)).toBeNull();
  });

  it('ignores unusable points rather than treating them as free fuel', () => {
    const junk = [{ month: '2026-03', centsPerLitre: 0 }, { month: '2026-04', centsPerLitre: Number.NaN }];
    expect(priceForMonth('2026-04', junk)).toBeNull();
  });

  it('sorts a series that arrives out of order', () => {
    expect(priceForMonth('2026-08', [...SERIES].reverse())?.from).toBe('2026-06');
  });
});

describe('compareToGasoline', () => {
  it('prices each drive at its own month', () => {
    /*
      The whole point. 100 km in January at 130.0¢ and 100 km in May at 191.1¢ are
      9 L and 9 L of the same fuel at very different money — $11.70 and $17.20.
    */
    const result = compareToGasoline(
      [drive('2026-01-15T12:00:00Z', 100), drive('2026-05-15T12:00:00Z', 100)],
      SERIES,
      9,
      localDateOf,
    );
    expect(result.litres).toBeCloseTo(18, 5);
    expect(result.gasCost).toBeCloseTo(9 * 1.3 + 9 * 1.911, 4);
    expect(result.publishedKm).toBe(200);
    expect(result.carriedForwardKm).toBe(0);
  });

  it('is not the same as pricing everything at the newest figure', () => {
    // The regression this whole file exists to prevent.
    const drives = [drive('2026-01-15T12:00:00Z', 100), drive('2026-05-15T12:00:00Z', 100)];
    const dated = compareToGasoline(drives, SERIES, 9, localDateOf).gasCost;
    const flat = (200 / 100) * 9 * 1.726;
    expect(Math.abs(dated - flat)).toBeGreaterThan(1);
  });

  it('separates what was carried forward from what was published', () => {
    const result = compareToGasoline(
      [drive('2026-03-10T12:00:00Z', 100), drive('2026-08-01T12:00:00Z', 142)],
      SERIES,
      9,
      localDateOf,
    );
    expect(result.publishedKm).toBe(100);
    expect(result.carriedForwardKm).toBe(142);
    expect(result.carriedFrom).toBe('2026-06');
    expect(result.carriedForwardCost).toBeCloseTo((142 / 100) * 9 * 1.726, 4);
    // The caveat has to be a share of the total, not a footnote — half this figure rests
    // on a price nobody has published for the month it is being applied to.
    expect(result.carriedForwardCost).toBeLessThan(result.gasCost);
  });

  it('counts distance it cannot price instead of pricing it at zero', () => {
    // A drive priced at nothing reads as a drive that cost nothing.
    const result = compareToGasoline([drive('2024-06-01T12:00:00Z', 500)], SERIES, 9, localDateOf);
    expect(result.unpricedKm).toBe(500);
    expect(result.gasCost).toBe(0);
    expect(result.litres).toBe(0);
  });

  it('refuses a consumption figure that cannot describe a car', () => {
    for (const bad of [0, -9, Number.NaN]) {
      expect(compareToGasoline([drive('2026-03-10T12:00:00Z', 100)], SERIES, bad, localDateOf).gasCost).toBe(0);
    }
  });

  it('ignores drives with no usable distance', () => {
    const result = compareToGasoline(
      [drive('2026-03-10T12:00:00Z', 0), drive('2026-03-11T12:00:00Z', Number.NaN)],
      SERIES,
      9,
      localDateOf,
    );
    expect(result.gasCost).toBe(0);
    expect(result.unpricedKm).toBe(0);
  });

  it('has nothing to say with an empty series', () => {
    const result = compareToGasoline([drive('2026-03-10T12:00:00Z', 100)], [], 9, localDateOf);
    expect(result.gasCost).toBe(0);
    expect(result.unpricedKm).toBe(100);
  });
});

describe('describeBasis', () => {
  it('names both tiers and the month borrowed from', () => {
    const result = compareToGasoline(
      [drive('2026-03-10T12:00:00Z', 100), drive('2026-08-01T12:00:00Z', 142)],
      SERIES,
      9,
      localDateOf,
    );
    const text = describeBasis(result);
    expect(text).toContain('100 km priced at the published average');
    expect(text).toContain("142 km priced at 2026-06's average");
    expect(text).toContain('no figure has been published');
  });

  it('says so when distance was left out', () => {
    const result = compareToGasoline([drive('2024-06-01T12:00:00Z', 500)], SERIES, 9, localDateOf);
    expect(describeBasis(result)).toContain('left out entirely');
  });

  it('does not mention a tier that is empty', () => {
    const result = compareToGasoline([drive('2026-03-10T12:00:00Z', 100)], SERIES, 9, localDateOf);
    const text = describeBasis(result);
    expect(text).not.toContain('carried');
    expect(text).not.toContain('left out');
  });
});

describe('monthOf', () => {
  it('buckets by local month, not UTC', () => {
    expect(monthOf('2026-03-15T12:00:00Z', localDateOf)).toBe('2026-03');
  });

  it('returns null for an unreadable timestamp', () => {
    expect(monthOf('not a date', localDateOf)).toBeNull();
  });
});
