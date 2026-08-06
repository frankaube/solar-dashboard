import { describe, expect, it } from 'vitest';
import { RateEntry, rateOn, retailOf, weightedRate } from '../src/readings/rate-history';

/*
  Storing one price and applying it to all history means every figure the app has ever shown
  changes the day a utility raises its rate — retroactively, and silently. A savings total
  somebody wrote down last winter stops matching the one on screen, and nothing says why.

  So the property under test throughout is that a day is valued at the rate that was in
  effect on that day, and that a period spanning a change is valued at what it actually
  cost rather than at either end of the range.
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
    /*
      Bills print the pre-tax energy rate, so this is the figure people actually copy in.
      This install typed 15.39c where 17.70c was meant and undercounted every dollar in the
      app by the tax until the setting existed.
    */
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
      The correction that matters most in this file, and it came from a real plan: somebody
      whose rate has never changed intends to record only the increase, on the day it
      arrives. Applying the oldest entry backwards priced every month before it at the NEW
      higher rate — the retroactive change this whole feature exists to prevent, caused by
      the feature itself.

      Null instead, and the caller supplies the configured price: what those days were
      already being valued at, so nothing moves until a rate is said to cover them.
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
    /*
      A rate in effect through December carried less energy than one in effect through June.
      Averaging them evenly prices a year as though the sun were uniform — 0.15 here, where
      the truth is 0.18 because nine tenths of the energy came at the higher rate.
    */
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
      The property the whole approach rests on: every rule in the programme engine is linear
      in retail, so a period valued at the production-weighted mean equals each day valued
      at its own rate. Exactly, not approximately — which is what makes it possible to price
      history correctly without rewriting the valuation engine to iterate days.
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
    /*
      The same correction, seen through the function the app actually calls. Recording only
      an increase must leave everything before it exactly as it was.
    */
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
