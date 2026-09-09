import { AlertCandidate } from './alert-rules';

/**
 * A day where the array produced and the meter recorded no export is usually net metering
 * that was never activated. Only days still running qualify; older ones are history.
 */

const MS_PER_DAY = 86_400_000;

/**
 * A resumed meter leaves metered days behind it, so unmetered days still touching the end
 * of the record mean it has not resumed.
 */
export const RECENT_WINDOW_DAYS = 7;

export interface UnmeteredDay {
  date: string;
  /**
   * Zero means unknown, not nothing: the day was flagged because production existed, so a
   * zero is history rolled out of the rollup. The message drops the figure in that case.
   */
  producedKwh: number;
}

export interface MeterCoverage {
  /** Newest imported reading date, YYYY-MM-DD. Null when nothing has been imported. */
  newestDate: string | null;
  unmetered: UnmeteredDay[];
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** Windowed against the newest *reading*, not today: a published usage export always lags. */
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
      // Serious, unlike the import reminder next door: energy is leaving unpaid.
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
