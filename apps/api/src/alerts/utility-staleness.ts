import { AlertCandidate } from './alert-rules';

/**
 * Reminding the owner that the utility has published another month.
 *
 * Imported meter data is the only measured self-consumption most installs will ever have,
 * and it decays: every day past the last imported reading is a day the savings page falls
 * back to an estimate without saying that it used to know better. Nothing in the app can
 * fetch it — utility portals are behind logins — so the only mechanism available is asking.
 *
 * Deliberately not "every 30 days from the last import". A billing period is about a
 * month, and the export for it appears days-to-weeks after it closes; a thirty-day timer
 * would fire while the data genuinely did not exist yet, teach the owner that the reminder
 * is usually wrong, and then be ignored on the occasion it was right. The threshold is
 * measured from the newest *reading* rather than from when the file was uploaded, so it
 * tracks the utility's publishing rather than the owner's habits.
 */

const MS_PER_DAY = 86_400_000;

/**
 * How far behind the newest reading may fall before this asks.
 *
 * Forty days: a billing period plus enough grace that the next export has plausibly been
 * published. Below about thirty-five this fires every cycle for a file that does not exist.
 */
export const STALE_AFTER_DAYS = 40;

export interface UtilityFreshness {
  /** Newest reading date held, YYYY-MM-DD. Null when nothing has ever been imported. */
  newestDate: string | null;
}

/**
 * A reminder, or nothing.
 *
 * Silent on an install that has never imported anything — that is not a lapsed habit, it is
 * a feature the owner has not chosen, and nagging about an unused feature is how people
 * learn to ignore a notifier. It speaks only to someone who has done this before and would
 * presumably want to again.
 */
export function evaluateUtilityStaleness(
  freshness: UtilityFreshness,
  now: Date,
): AlertCandidate[] {
  if (!freshness.newestDate) return [];
  const newest = Date.parse(`${freshness.newestDate}T00:00:00Z`);
  if (!Number.isFinite(newest)) return [];

  const days = Math.floor((now.getTime() - newest) / MS_PER_DAY);
  if (days < STALE_AFTER_DAYS) return [];

  return [
    {
      type: 'utility_data_stale',
      /*
        A warning, not serious. Nothing is broken and no reading is wrong — the app has
        simply stopped being able to measure a number it can still estimate. Ranking it
        with a dead inverter would be the fastest way to make both easy to ignore.
      */
      severity: 'warning',
      subjectKey: 'utility-usage',
      message:
        `The last meter data imported ends ${freshness.newestDate}, ${days} days ago. ` +
        'Your utility has almost certainly published another period since. Until it is ' +
        'imported, self-consumption falls back to the share estimated in Settings.',
    },
  ];
}
