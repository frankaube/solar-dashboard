/**
 * The share of production a house actually uses, measured instead of guessed.
 *
 * "Solar used as you make it" is a percentage typed into Settings, and it is the single
 * most load-bearing assumption in the app: it decides how much of every kilowatt-hour that
 * was never metered gets valued at the self-use rate rather than the export one. Everyone
 * types a round number, because nobody knows theirs.
 *
 * Once meter data exists, they do not have to. Across the days a meter covered, what stayed
 * home is production minus export — so the share is arithmetic, and it is *this* house's
 * share rather than a plausible one. Applied to the days no meter covers, it is still an
 * assumption, but an assumption calibrated on the same roof and the same habits instead of
 * on a guess.
 *
 * Deliberately not automatic without being asked. Replacing a figure someone entered with
 * one this computed, silently, would leave them looking at a number they did not choose and
 * cannot find the source of — and the first thing they would do is type the old one back.
 */

/** Days a meter covered, with what the array made on each. */
export interface CoveredDay {
  date: string;
  producedKwh: number;
  exportedKwh: number;
}

/**
 * Below this the share is not worth deriving.
 *
 * One full week, because the dominant cycle in household load is weekly — people are out
 * on weekdays and home at weekends, and a sample of five days is not a smaller version of
 * that pattern but a biased slice of it. Seven days covers the cycle exactly once.
 *
 * It does not cover the year, and nothing here pretends otherwise: a share measured in
 * July describes a July house. That limit is the same at any threshold this side of a
 * season, so it is not an argument for demanding a fortnight — it is an argument for
 * saying, next to the figure, how long it was measured over.
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
 * What this house actually used, as a percentage of what it made.
 *
 * Clamped into 0–100. Outside that the inputs disagree — an export figure covering a
 * different window than the production it is divided by, most often — and the nearest
 * possible answer beats a share above unity, which would quietly value more energy at the
 * self-use rate than the array ever produced.
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
