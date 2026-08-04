/**
 * The site's timezone — which calendar day a reading belongs to.
 *
 * This was a hardcoded zone, which made every daily figure silently
 * wrong for anyone else: production per day, "best day", the month and year rollups
 * and the savings periods are all bucketed by local date, so a user a few hours away
 * gets numbers that look entirely normal and are attributed to the wrong day.
 *
 * RESOLUTION ORDER, and the reason it is not simply "use the system zone":
 *
 *   1. `SITE_TIMEZONE`, if set and valid.
 *   2. `TZ`, if set and valid — Docker's conventional way of saying the same thing.
 *   3. The system zone, if it is not UTC.
 *   4. UTC.
 *
 * Step 3 excludes UTC deliberately. A container has no timezone unless it is given
 * one, so `Intl` resolves to UTC — and silently adopting that would have shifted this
 * install's day boundaries by three hours and mixed the new rows in with months of
 * rows bucketed the old way. An unset zone in a container is missing information, not
 * an assertion that the site is in UTC, and conflating the two would reintroduce the
 * exact silent wrongness this change exists to remove.
 *
 * Resolved once at load: these are process environment values that cannot change
 * while running, and re-reading them per call would only invite inconsistency
 * partway through a request.
 */

const FALLBACK = 'UTC';

/** Does Intl accept this as an IANA zone? The only honest way to ask. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface TimeZoneResolution {
  timeZone: string;
  /** Where it came from, so startup can say so and a wrong one is findable. */
  source: 'SITE_TIMEZONE' | 'TZ' | 'system' | 'fallback';
  /** Set when a configured value was rejected — worth warning about loudly. */
  rejected?: string;
}

/**
 * `systemZone` is `string | null`, not `string | undefined`, on purpose.
 *
 * A default parameter only fires for `undefined`, so a caller passing an explicitly
 * undefined value would silently get the real machine's zone instead of the "none"
 * they meant — which is exactly how a test can pass while asserting the opposite of
 * what the code does. `null` says none and cannot be confused with "argument omitted".
 */
export function resolveSiteTimeZone(
  env: NodeJS.ProcessEnv = process.env,
  systemZone: string | null = Intl.DateTimeFormat().resolvedOptions().timeZone,
): TimeZoneResolution {
  for (const key of ['SITE_TIMEZONE', 'TZ'] as const) {
    const configured = env[key]?.trim();
    if (!configured) continue;
    if (isValidTimeZone(configured)) return { timeZone: configured, source: key };
    /*
      An invalid zone is a typo, and it must not take the app down: every Intl call
      built on it would throw a RangeError, so the dashboard would answer 500s rather
      than show a wrong date. Fall back and report it instead.
    */
    return { timeZone: FALLBACK, source: 'fallback', rejected: configured };
  }
  if (systemZone && systemZone !== 'UTC' && isValidTimeZone(systemZone)) {
    return { timeZone: systemZone, source: 'system' };
  }
  return { timeZone: FALLBACK, source: 'fallback' };
}

export const SITE_TIMEZONE_RESOLUTION = resolveSiteTimeZone();

/** Site timezone for daily rollups. Set SITE_TIMEZONE to configure it. */
export const SITE_TIMEZONE = SITE_TIMEZONE_RESOLUTION.timeZone;

/** YYYY-MM-DD of an instant in the site timezone (en-CA yields ISO order). */
export function localDateOf(date: Date, timeZone: string = SITE_TIMEZONE): string {
  /*
    Assembled from parts, never from a locale's own formatting.

    This was `new Intl.DateTimeFormat('en-CA', { timeZone }).format(date)`, which relies on
    en-CA existing and rendering ISO. It does under a full-ICU Node — and the packaged Lite
    build ships small-icu, where en-CA is absent and quietly falls back to US formatting.
    So the same code wrote "2026-07-30" under Docker and "7/30/2026" on the Pi, into a
    column every daily and monthly rollup groups by. Silently: no error, no warning, just a
    month total that reads $1 because half the days no longer match the pattern.

    en-US is requested explicitly because it is the one locale guaranteed to be present in
    every build. Its output is never used as a string — only its parts are, read by name —
    so the result is ISO whatever the locale data happens to contain.
  */
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: 'year' | 'month' | 'day'): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
