import { AlertCandidate } from './alert-rules';

/**
 * Imported meter data is the only measured self-consumption most installs will have, and
 * nothing here can fetch it — utility portals are behind logins. Measured from the newest
 * *reading*, not the upload: an export appears days-to-weeks after its period closes.
 */

const MS_PER_DAY = 86_400_000;

/**
 * A billing period plus grace. Below about thirty-five days this fires every cycle for a
 * file that does not exist yet.
 */
export const STALE_AFTER_DAYS = 40;

export interface UtilityFreshness {
  /** Newest reading date held, YYYY-MM-DD. Null when nothing has ever been imported. */
  newestDate: string | null;
}

/** Silent on an install that has never imported: an unchosen feature, not a lapsed habit. */
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
      // Warning, not serious: a number that can still be estimated stopped being measured.
      severity: 'warning',
      subjectKey: 'utility-usage',
      message:
        `The last meter data imported ends ${freshness.newestDate}, ${days} days ago. ` +
        'Your utility has almost certainly published another period since. Until it is ' +
        'imported, self-consumption falls back to the share estimated in Settings.',
    },
  ];
}
