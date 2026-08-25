/**
 * What a kilowatt-hour cost, on the day it was produced.
 *
 * A single stored `electricityPricePerKwh` applied to all history changes every past figure
 * retroactively the day a utility raises its rate. So each period is priced at the rate
 * actually in effect, and today's is never assumed to apply backwards.
 *
 * A rate is more than a price: sales tax changes too, and whether a typed figure includes it
 * is a property of that entry rather than of the install.
 */

export interface RateEntry {
  /** Site-local YYYY-MM-DD. The first day this rate applied. */
  effectiveFrom: string;
  pricePerKwh: number;
  /** Sales tax as a fraction, e.g. 0.15. */
  hstRate: number;
  /** Whether `pricePerKwh` already includes the tax above. */
  priceIncludesTax: boolean;
}

/** The tax-inclusive price — what a kilowatt-hour actually costs at the till. */
export function retailOf(entry: RateEntry): number {
  const tax = Number.isFinite(entry.hstRate) && entry.hstRate > 0 ? entry.hstRate : 0;
  return entry.priceIncludesTax ? entry.pricePerKwh : entry.pricePerKwh * (1 + tax);
}

/** Oldest first, which every function here assumes. */
export function sortRates(entries: RateEntry[]): RateEntry[] {
  return [...entries].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/**
 * The rate in effect on a given day, or null before the earliest one begins.
 *
 * Null, NOT "the earliest entry applies backwards": somebody who records only an increase,
 * on the day it arrived, would have every earlier month revalued at the new higher rate —
 * exactly the retroactive change this file exists to prevent. The caller supplies the
 * fallback, which is the configured price.
 */
export function rateOn(entries: RateEntry[], date: string): RateEntry | null {
  const sorted = sortRates(entries);
  let found: RateEntry | null = null;
  for (const entry of sorted) {
    if (entry.effectiveFrom <= date) found = entry;
    else break;
  }
  return found;
}

export interface DayProduction {
  date: string;
  energyWh: number;
}

export interface WeightedRate {
  /** Production-weighted tax-inclusive price across the days supplied. */
  retail: number;
  /** Production-weighted tax rate, for the programmes whose rules use it. */
  hstRate: number;
  /** True when more than one rate applied across the period. */
  mixed: boolean;
  /** The distinct rates that applied, oldest first — for saying so on screen. */
  applied: RateEntry[];
}

/**
 * One rate for a period, weighted by the production it is applied to.
 *
 * INVARIANT: every rule in `reward-programs` is linear in the retail price, so each day at
 * its own rate sums exactly to the period total at the production-weighted mean. Adding a
 * non-linear rule (a standing charge, a tiered block tariff) breaks this and would force
 * the valuation engine to iterate days.
 *
 * Weighted by production, not day count: December carried less energy than June.
 */
export function weightedRate(
  entries: RateEntry[],
  days: DayProduction[],
  fallback: RateEntry,
): WeightedRate {
  const usable = days.filter((day) => Number.isFinite(day.energyWh) && day.energyWh > 0);
  const totalWh = usable.reduce((sum, day) => sum + day.energyWh, 0);

  if (entries.length === 0 || totalWh === 0) {
    return {
      retail: retailOf(fallback),
      hstRate: fallback.hstRate,
      mixed: false,
      applied: entries.length ? [rateOn(entries, days[0]?.date ?? '9999-12-31') ?? fallback] : [fallback],
    };
  }

  let retailWh = 0;
  let taxWh = 0;
  const seen = new Map<string, RateEntry>();
  for (const day of usable) {
    const entry = rateOn(entries, day.date) ?? fallback;
    seen.set(entry.effectiveFrom, entry);
    retailWh += retailOf(entry) * day.energyWh;
    taxWh += entry.hstRate * day.energyWh;
  }

  return {
    retail: retailWh / totalWh,
    hstRate: taxWh / totalWh,
    mixed: seen.size > 1,
    applied: sortRates([...seen.values()]),
  };
}
