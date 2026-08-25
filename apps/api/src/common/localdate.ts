/**
 * The site's timezone — which calendar day a reading belongs to. Resolution order:
 *
 *   1. `SITE_TIMEZONE`, if set and valid.
 *   2. `TZ`, if set and valid — Docker's conventional way of saying the same thing.
 *   3. The system zone, if it is not UTC.
 *   4. UTC.
 *
 * Step 3 excludes UTC deliberately: a container has no timezone unless given one, so `Intl`
 * resolves to UTC, and that is missing information rather than an assertion about the site.
 */

const FALLBACK = 'UTC';

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
  /** Where it came from, so startup can report it. */
  source: 'SITE_TIMEZONE' | 'TZ' | 'system' | 'fallback';
  /** Set when a configured value was rejected. */
  rejected?: string;
}

/**
 * `systemZone` is `string | null`, not `string | undefined`: a default parameter only fires
 * for `undefined`, so an explicit undefined would get the machine's zone, not "none".
 */
export function resolveSiteTimeZone(
  env: NodeJS.ProcessEnv = process.env,
  systemZone: string | null = Intl.DateTimeFormat().resolvedOptions().timeZone,
): TimeZoneResolution {
  for (const key of ['SITE_TIMEZONE', 'TZ'] as const) {
    const configured = env[key]?.trim();
    if (!configured) continue;
    if (isValidTimeZone(configured)) return { timeZone: configured, source: key };
    // An invalid zone makes every Intl call on it throw a RangeError. Fall back, report it.
    return { timeZone: FALLBACK, source: 'fallback', rejected: configured };
  }
  if (systemZone && systemZone !== 'UTC' && isValidTimeZone(systemZone)) {
    return { timeZone: systemZone, source: 'system' };
  }
  return { timeZone: FALLBACK, source: 'fallback' };
}

export const SITE_TIMEZONE_RESOLUTION = resolveSiteTimeZone();

export const SITE_TIMEZONE = SITE_TIMEZONE_RESOLUTION.timeZone;

/** YYYY-MM-DD of an instant in the site timezone. */
/*
  Built once per timezone: constructing an Intl.DateTimeFormat costs roughly ten times the
  format call it enables, and `localDateOf` runs once per reading, point and rollup row.
*/
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const found = FORMATTERS.get(timeZone);
  if (found) return found;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  FORMATTERS.set(timeZone, made);
  return made;
}

export function localDateOf(date: Date, timeZone: string = SITE_TIMEZONE): string {
  /*
    `.format()` on an en-CA formatter yields ISO only under full-ICU Node; the packaged Lite
    build ships small-icu, where en-CA is absent and silently falls back to "7/30/2026".
    en-US is present in every build, and only its parts are read by name, so this is ISO.
  */
  const parts = dateFormatter(timeZone).formatToParts(date);
  const get = (type: 'year' | 'month' | 'day'): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
