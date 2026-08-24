/**
 * What a kilowatt-hour cost, on the day it was produced.
 *
 * The app stored one `electricityPricePerKwh` and applied it to everything. That is right
 * until the first time a utility raises its rate — and then it is wrong about every figure
 * it has ever shown. Last year's savings are recomputed at this year's price, the payback
 * curve bends, and nothing on screen says why. The numbers do not merely drift; they change
 * retroactively, which is worse, because a figure somebody wrote down no longer matches the
 * one the app shows.
 *
 * This is the same mistake the petrol comparison made and the same fix: price each period
 * at the rate that was actually in effect, and say when a rate began rather than assuming
 * today's applies backwards.
 *
 * A rate is more than a price. Sales tax changes too, rarely, and whether a typed figure
 * already includes it is a property of that entry rather than of the install — somebody who
 * copied a pre-tax rate off a 2024 bill and a tax-inclusive one off a 2026 bill has both,
 * and neither is wrong.
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
 * Null rather than "the earliest entry applies backwards", which is what this did first and
 * was wrong in the commonest case there is. Somebody whose rate has never changed records
 * only the increase, on the day it arrives — and every month before it was then valued at
 * the NEW higher rate, which is precisely the retroactive change this whole file exists to
 * prevent. It made the feature cause the bug it was written to fix.
 *
 * The caller supplies what to use instead, and the honest answer is the configured price:
 * that is what those days were being valued at before any of this existed, so nothing moves
 * until somebody says a rate applied from a date that covers them.
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
 * One rate for a period, weighted by the production it is being applied to.
 *
 * Every rule in `reward-programs` is linear in the retail price — rates are per-kWh, and
 * the ones that are not given outright are derived from retail by multiplication. So the
 * sum of each day valued at its own rate equals the period's total valued at the
 * production-weighted mean, exactly rather than approximately. That is what makes it
 * possible to price history correctly without rewriting the valuation engine to iterate
 * days, and it is worth stating because it stops being true the moment a rule is added
 * that is not linear — a standing charge, or a tiered block tariff.
 *
 * Weighted by production rather than by day count: a rate that was in effect through
 * December contributed less energy than one in effect through June, and averaging the two
 * evenly would price a year as though the sun were uniform.
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
