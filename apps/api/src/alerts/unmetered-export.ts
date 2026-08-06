import { AlertCandidate } from './alert-rules';

/**
 * The meter is not counting what leaves the property — right now, not once.
 *
 * A day where the array produced and the meter recorded no export at all is usually a
 * net-metering agreement that has not been activated: the energy leaves, the utility does
 * not credit it, and nothing on a bill says so. On one install that was four days and
 * 367 kWh given away before anybody noticed.
 *
 * The Savings page used to state this as a standing fact, which was the wrong shape for it.
 * Four days that ended in July are history — priced on the credit card, where they belong —
 * while four days that are still running are money leaving the property this week. A line
 * that reads identically for both carries no signal, so this fires only for the second.
 */

const MS_PER_DAY = 86_400_000;

/**
 * How close to the newest reading an unmetered day must be to count as live.
 *
 * One week. A meter that resumed counting leaves metered days behind it, so unmetered days
 * still touching the end of the record mean it has not resumed — whereas the same days with
 * a fortnight of normal readings after them are a fault that fixed itself.
 */
export const RECENT_WINDOW_DAYS = 7;

export interface UnmeteredDay {
  date: string;
  /**
   * What the array made that day. The size of the giveaway, and why this is worth saying.
   *
   * Zero means unknown rather than nothing: the day was flagged at import time precisely
   * because production existed, so a zero here is history that has rolled out of the
   * rollup — or a source that publishes only a lifetime accumulator. The message drops
   * the figure in that case instead of announcing a giveaway of 0 kWh.
   */
  producedKwh: number;
}

export interface MeterCoverage {
  /** Newest imported reading date, YYYY-MM-DD. Null when nothing has been imported. */
  newestDate: string | null;
  unmetered: UnmeteredDay[];
}

const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * An alert, or nothing.
 *
 * Windowed against the newest *reading* rather than against today, because a published
 * usage export always lags — measuring from now would go quiet during the weeks the
 * utility had simply not published yet, which is exactly when the fault is still running.
 */
export function evaluateUnmeteredExport(coverage: MeterCoverage): AlertCandidate[] {
  if (!coverage.newestDate) return [];
  const newest = Date.parse(`${coverage.newestDate}T00:00:00Z`);
  if (!Number.isFinite(newest)) return [];

  const cutoff = newest - RECENT_WINDOW_DAYS * MS_PER_DAY;
  const recent = coverage.unmetered.filter((day) => {
    const at = Date.parse(`${day.date}T00:00:00Z`);
    return Number.isFinite(at) && at > cutoff && at <= newest;
  });
  if (recent.length === 0) return [];

  const kwh = round(recent.reduce((total, day) => total + day.producedKwh, 0));
  const oldest = recent.reduce((min, day) => (day.date < min ? day.date : min), recent[0].date);

  return [
    {
      /*
        Serious, unlike the import reminder next door. That one says a number has stopped
        being measured and is being estimated instead; this one says energy is leaving the
        property and nobody is being paid for it. Ranking them together would flatten the
        difference between "the app knows less" and "you are losing money".
      */
      type: 'utility_export_uncounted',
      severity: 'serious',
      subjectKey: 'utility-usage',
      message:
        `Your meter recorded no export on ${recent.length} of the days up to ` +
        `${coverage.newestDate}` +
        (kwh > 0 ? `, while the array produced ${kwh} kWh` : ', though the array was producing') +
        `${recent.length > 1 ? ` (from ${oldest})` : ''}. ` +
        'That usually means net metering has not been activated — the energy left the ' +
        'property and was not credited. Worth asking your utility about.',
    },
  ];
}
