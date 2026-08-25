/**
 * The share of production a house actually uses, measured instead of guessed.
 *
 * "Solar used as you make it" decides how much unmetered generation is valued at the
 * self-use rate rather than the export one — the most load-bearing assumption in the app.
 *
 * Across the days a meter covered, what stayed home is production minus export, so the
 * share is arithmetic and specific to this house; on uncovered days it is a calibrated
 * assumption. Never applied unless asked: it must not replace a figure the owner typed.
 */

/** Days a meter covered, with what the array made on each. */
export interface CoveredDay {
  date: string;
  producedKwh: number;
  exportedKwh: number;
}

/**
 * Below this the share is not worth deriving. One full week: the dominant cycle in household
 * load is weekly, so five days is a biased slice of it rather than a smaller version.
 *
 * It does not cover the year — a share measured in July describes a July house — which is
 * why callers show how long it was measured over.
 */
export const MIN_DAYS = 7;
/** And enough energy that a rounding error in one day cannot move the answer. */
export const MIN_PRODUCED_KWH = 100;

export interface MeasuredShare {
  /** Percent, 0–100. Null when the record cannot support one. */
  pct: number | null;
  days: number;
  producedKwh: number;
  selfConsumedKwh: number;
  /** Why there is no figure, when there is none. */
  reason: string | null;
}

/**
 * What this house actually used, as a percentage of what it made. Clamped into 0–100:
 * outside that the inputs disagree (usually an export figure over a different window than
 * the production it divides), and a share above unity would value more energy at the
 * self-use rate than the array produced.
 */
export function measuredSelfConsumptionShare(days: CoveredDay[]): MeasuredShare {
  const usable = days.filter(
    (day) =>
      Number.isFinite(day.producedKwh) &&
      Number.isFinite(day.exportedKwh) &&
      day.producedKwh > 0 &&
      day.exportedKwh >= 0,
  );
  const producedKwh = usable.reduce((total, day) => total + day.producedKwh, 0);
  const exportedKwh = usable.reduce((total, day) => total + day.exportedKwh, 0);
  const selfConsumedKwh = Math.max(0, Math.min(producedKwh, producedKwh - exportedKwh));

  const base = { days: usable.length, producedKwh, selfConsumedKwh };
  if (usable.length < MIN_DAYS) {
    return {
      ...base,
      pct: null,
      reason: `${usable.length} metered day(s) so far; a share needs about ${MIN_DAYS} to stop swinging with the weather.`,
    };
  }
  if (producedKwh < MIN_PRODUCED_KWH) {
    return {
      ...base,
      pct: null,
      reason: `Only ${Math.round(producedKwh)} kWh across those days — too little for the share to mean much.`,
    };
  }
  return {
    ...base,
    pct: Math.round((selfConsumedKwh / producedKwh) * 1000) / 10,
    reason: null,
  };
}
