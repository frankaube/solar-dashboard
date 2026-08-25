/**
 * Pricing a drive against the gasoline it did not burn, at the price of the month it
 * happened: over eighteen months one city in the published series ran 130.0¢ to 191.1¢.
 *
 * The series is a monthly average released about six weeks in arrears, so recent drives
 * fall in months that do not exist yet. Those are priced at the newest published figure,
 * and every result splits published from carried-forward distance for the caller to report.
 *
 * Litres per hundred kilometres describes a vehicle that was never bought and stays an
 * estimate however good the prices get.
 */

/** A published monthly average. */
export interface FuelPricePoint {
  /** YYYY-MM, the month the average describes — not when it was published. */
  month: string;
  centsPerLitre: number;
}

export interface PricedDrive {
  startedAt: string;
  distanceKm: number;
  consumptionKwh: number | null;
}

export type PriceBasis = 'published' | 'carried-forward';

export interface FuelComparison {
  /** Litres a comparable petrol car would have burned over the priced distance. */
  litres: number;
  /** What those litres would have cost, each drive at its own month's price. */
  gasCost: number;
  /** Distance that met a price published for its own month. */
  publishedKm: number;
  /** Distance priced at the newest published figure because its month is not out yet. */
  carriedForwardKm: number;
  /** Portion of `gasCost` that rests on a carried-forward price. */
  carriedForwardCost: number;
  /** The month carried-forward drives borrowed from, if any were. */
  carriedFrom: string | null;
  /** Drives with no usable price at all — before the series begins. Never guessed. */
  unpricedKm: number;
}

const KM_PER_100 = 100;
const CENTS = 100;

/** YYYY-MM for an instant, using the same local-date function as everything else. */
export function monthOf(startedAt: string, localDateOf: (date: Date) => string): string | null {
  const at = new Date(startedAt);
  return Number.isFinite(at.getTime()) ? localDateOf(at).slice(0, 7) : null;
}

/**
 * The price to use for a given month. Exact match wins; otherwise the newest published
 * month *before* it, reported as carried forward. A month earlier than anything published
 * gets nothing: reaching forward borrows the nearest price in time, back the furthest.
 */
export function priceForMonth(
  month: string,
  series: FuelPricePoint[],
): { centsPerLitre: number; basis: PriceBasis; from: string } | null {
  const sorted = [...series]
    .filter((p) => Number.isFinite(p.centsPerLitre) && p.centsPerLitre > 0)
    .sort((a, b) => a.month.localeCompare(b.month));
  if (sorted.length === 0) return null;

  const exact = sorted.find((p) => p.month === month);
  if (exact) return { centsPerLitre: exact.centsPerLitre, basis: 'published', from: exact.month };

  let previous: FuelPricePoint | null = null;
  for (const point of sorted) {
    if (point.month < month) previous = point;
    else break;
  }
  return previous
    ? { centsPerLitre: previous.centsPerLitre, basis: 'carried-forward', from: previous.month }
    : null;
}

/**
 * What these drives would have cost in petrol, drive by drive. `litresPer100Km` is required
 * rather than defaulted: the assumption has to come from a setting a person chose.
 */
export function compareToGasoline(
  drives: PricedDrive[],
  series: FuelPricePoint[],
  litresPer100Km: number,
  localDateOf: (date: Date) => string,
): FuelComparison {
  const empty: FuelComparison = {
    litres: 0,
    gasCost: 0,
    publishedKm: 0,
    carriedForwardKm: 0,
    carriedForwardCost: 0,
    carriedFrom: null,
    unpricedKm: 0,
  };
  if (!Number.isFinite(litresPer100Km) || litresPer100Km <= 0) return empty;

  const out = { ...empty };
  for (const drive of drives) {
    const km = drive.distanceKm;
    if (!Number.isFinite(km) || km <= 0) continue;

    const month = monthOf(drive.startedAt, localDateOf);
    const price = month ? priceForMonth(month, series) : null;
    if (!price) {
      // No price for this month and nothing earlier to borrow. Counted separately, not
      // priced at zero, so the caller can say the total covers less than the distance.
      out.unpricedKm += km;
      continue;
    }

    const litres = (km / KM_PER_100) * litresPer100Km;
    const cost = litres * (price.centsPerLitre / CENTS);
    out.litres += litres;
    out.gasCost += cost;
    if (price.basis === 'published') {
      out.publishedKm += km;
    } else {
      out.carriedForwardKm += km;
      out.carriedForwardCost += cost;
      // All carried-forward drives borrow the same newest month; take the latest anyway.
      if (out.carriedFrom === null || price.from > out.carriedFrom) out.carriedFrom = price.from;
    }
  }
  return out;
}

/**
 * How the result should be described, in one sentence. Lives here rather than in the UI so
 * the wording is tested alongside the arithmetic it describes.
 */
export function describeBasis(comparison: FuelComparison): string {
  const { publishedKm, carriedForwardKm, unpricedKm, carriedFrom } = comparison;
  const total = publishedKm + carriedForwardKm + unpricedKm;
  if (total === 0) return 'No drives to price.';

  const parts: string[] = [];
  if (publishedKm > 0) {
    parts.push(`${Math.round(publishedKm)} km priced at the published average for the month each drive happened in`);
  }
  if (carriedForwardKm > 0) {
    parts.push(
      `${Math.round(carriedForwardKm)} km priced at ${carriedFrom}'s average, because no figure has been published for those months yet`,
    );
  }
  if (unpricedKm > 0) {
    parts.push(`${Math.round(unpricedKm)} km left out entirely — no published price reaches back that far`);
  }
  return `${parts.join('; ')}.`;
}
