import { describe, expect, it } from 'vitest';
import { RateEntry, rateOn, retailOf, weightedRate } from '../src/readings/rate-history';

/*
  The property under test throughout: a day is valued at the rate that was in effect on that
  day, and a period spanning a change is valued at what it actually cost rather than at
  either end of the range. Storing one price and applying it to all history instead moves
  every figure the app has ever shown, retroactively, the day a utility raises its rate.
*/

const rate = (over: Partial<RateEntry> = {}): RateEntry => ({
  effectiveFrom: '2025-01-01',
  pricePerKwh: 0.16,
  hstRate: 0.15,
  priceIncludesTax: true,
  ...over,
});

describe('retailOf', () => {
  it('takes a tax-inclusive price at face value', () => {
    expect(retailOf(rate({ pricePerKwh: 0.177, priceIncludesTax: true }))).toBeCloseTo(0.177, 6);
  });

  it('adds the tax to a price that does not include it', () => {
    // Bills print the pre-tax energy rate, so that is the figure people copy in: 15.39c
    // pre-tax is 17.70c inclusive, and reading it as inclusive undercounts by the tax.
    expect(retailOf(rate({ pricePerKwh: 0.1539, hstRate: 0.15, priceIncludesTax: false })))
      .toBeCloseTo(0.177, 4);
  });

  it('treats a nonsense tax as no tax rather than as a multiplier', () => {
    expect(retailOf(rate({ pricePerKwh: 0.16, hstRate: -1, priceIncludesTax: false }))).toBeCloseTo(0.16, 6);
  });
});

describe('rateOn', () => {
  const entries = [
    rate({ effectiveFrom: '2025-01-01', pricePerKwh: 0.14 }),
    rate({ effectiveFrom: '2026-04-01', pricePerKwh: 0.18 }),
  ];

  it('picks the rate in effect that day', () => {
    expect(rateOn(entries, '2025-06-15')?.pricePerKwh).toBe(0.14);
    expect(rateOn(entries, '2026-06-15')?.pricePerKwh).toBe(0.18);
  });

  it('treats the effective date as the first day at the new rate', () => {
    expect(rateOn(entries, '2026-03-31')?.pricePerKwh).toBe(0.14);
    expect(rateOn(entries, '2026-04-01')?.pricePerKwh).toBe(0.18);
  });

  it('has no rate for days before the earliest one begins', () => {
    /*
      Someone whose rate has never changed records only the increase. Applying the oldest
      entry backwards would then price every month before it at the NEW higher rate — the
      retroactive change this feature exists to prevent. Null instead, and the caller
      supplies the configured price, so nothing moves until a rate is said to cover
      those days.
    */
    expect(rateOn(entries, '2020-01-01')).toBeNull();
  });

  it('is null for every day before a lone future-dated rate', () => {
    const onlyTheIncrease = [rate({ effectiveFrom: '2026-11-01', pricePerKwh: 0.2 })];
    expect(rateOn(onlyTheIncrease, '2026-08-01')).toBeNull();
    expect(rateOn(onlyTheIncrease, '2026-11-15')?.pricePerKwh).toBe(0.2);
  });

  it('is order-independent, because a UI will not insert them sorted', () => {
    const jumbled = [entries[1], entries[0]];
    expect(rateOn(jumbled, '2025-06-15')?.pricePerKwh).toBe(0.14);
  });

  it('has no answer with no rates at all', () => {
    expect(rateOn([], '2026-01-01')).toBeNull();
  });
});

describe('weightedRate', () => {
  const entries = [
    rate({ effectiveFrom: '2025-01-01', pricePerKwh: 0.10, priceIncludesTax: true }),
    rate({ effectiveFrom: '2026-01-01', pricePerKwh: 0.20, priceIncludesTax: true }),
  ];
  const fallback = rate();

  it('is the plain rate when only one applied', () => {
    const result = weightedRate(entries, [{ date: '2025-06-01', energyWh: 50_000 }], fallback);
    expect(result.retail).toBeCloseTo(0.1, 6);
    expect(result.mixed).toBe(false);
  });

  it('weights by production, not by the number of days', () => {
    // A rate in effect through December carries less energy than one in effect through
    // June; averaging evenly prices a year as though the sun were uniform (0.15 here).
    const result = weightedRate(
      entries,
      [
        { date: '2025-12-01', energyWh: 10_000 },
        { date: '2026-06-01', energyWh: 90_000 },
      ],
      fallback,
    );
    expect(result.retail).toBeCloseTo(0.19, 6);
    expect(result.mixed).toBe(true);
    expect(result.applied).toHaveLength(2);
  });

  it('equals the sum of the days priced individually', () => {
    /*
      Every rule in the programme engine is linear in retail, so a period valued at the
      production-weighted mean equals each day valued at its own rate — exactly, which is
      what lets history be priced without the valuation engine iterating days.
    */
    const days = [
      { date: '2025-05-01', energyWh: 30_000 },
      { date: '2025-11-01', energyWh: 12_000 },
      { date: '2026-02-01', energyWh: 25_000 },
      { date: '2026-07-01', energyWh: 61_000 },
    ];
    const result = weightedRate(entries, days, fallback);
    const perDay = days.reduce(
      (sum, day) => sum + (day.energyWh / 1000) * retailOf(rateOn(entries, day.date)!),
      0,
    );
    const totalKwh = days.reduce((sum, day) => sum + day.energyWh, 0) / 1000;
    expect(totalKwh * result.retail).toBeCloseTo(perDay, 9);
  });

  it('ignores days that produced nothing rather than letting them drag the mean', () => {
    const result = weightedRate(
      entries,
      [
        { date: '2025-06-01', energyWh: 0 },
        { date: '2026-06-01', energyWh: 50_000 },
      ],
      fallback,
    );
    expect(result.retail).toBeCloseTo(0.2, 6);
    expect(result.mixed).toBe(false);
  });

  it('uses the configured price for days before the earliest rate', () => {
    // The same rule through the function the app calls: recording only an increase must
    // leave everything before it exactly as it was.
    const onlyTheIncrease = [rate({ effectiveFrom: '2026-11-01', pricePerKwh: 0.5, priceIncludesTax: true })];
    const before = rate({ effectiveFrom: '1970-01-01', pricePerKwh: 0.16, priceIncludesTax: true });
    const result = weightedRate(onlyTheIncrease, [{ date: '2026-08-01', energyWh: 50_000 }], before);
    expect(result.retail).toBeCloseTo(0.16, 6);
  });

  it('falls back rather than dividing by nothing', () => {
    const result = weightedRate(entries, [], fallback);
    expect(result.retail).toBeCloseTo(retailOf(fallback), 6);
    expect(result.mixed).toBe(false);
  });

  it('weights the tax too, since that changes as well', () => {
    const taxed = [
      rate({ effectiveFrom: '2025-01-01', hstRate: 0.13 }),
      rate({ effectiveFrom: '2026-01-01', hstRate: 0.15 }),
    ];
    const result = weightedRate(
      taxed,
      [
        { date: '2025-06-01', energyWh: 50_000 },
        { date: '2026-06-01', energyWh: 50_000 },
      ],
      fallback,
    );
    expect(result.hstRate).toBeCloseTo(0.14, 6);
  });
});
