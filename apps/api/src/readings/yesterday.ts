import { SITE_TIMEZONE } from '../common/localdate';

/**
 * What the array was doing at this time yesterday, for the expected-vs-actual tooltip.
 *
 * MATCHED ON THE CLOCK, NOT ON ELAPSED HOURS: "yesterday at 11:07" and "24 hours ago" differ
 * on the two DST changeover days, and for a solar curve an hour is a different sun angle, so
 * the target is rebuilt from the wall clock in the site's own timezone.
 *
 * Nothing is interpolated: with no nearby reading the answer is null.
 */

/** How close a reading has to be to count as "that moment". Samples arrive every five. */
export const MATCH_WINDOW_MS = 6 * 60_000;

export interface Reading {
  t: string;
  powerW: number;
}

/*
  Formatters, built once per timezone. `new Intl.DateTimeFormat(...)` costs an order of
  magnitude more than the format call it enables: constructing two per call meant 564 of
  them to draw one day's chart, 24 ms against 2.3 ms hoisted on a desktop and worse on a Pi.
  A map because the zone is a parameter; in practice it holds one entry.
*/
const WITH_SECONDS = new Map<string, Intl.DateTimeFormat>();
const WITHOUT_SECONDS = new Map<string, Intl.DateTimeFormat>();

function formatter(cache: Map<string, Intl.DateTimeFormat>, timeZone: string, seconds: boolean): Intl.DateTimeFormat {
  const found = cache.get(timeZone);
  if (found) return found;
  const made = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' as const } : {}),
    hour12: false,
  });
  cache.set(timeZone, made);
  return made;
}

/**
 * The instant one local day earlier, at the same wall-clock time. Built by asking Intl what
 * the instant looks like in the zone, stepping the date back a day, and converting back — a
 * flat 24-hour subtraction drifts by an hour across a daylight-saving boundary.
 */
export function sameClockYesterday(at: Date, timeZone: string = SITE_TIMEZONE): Date {
  const parts = formatter(WITH_SECONDS, timeZone, true).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);

  // Step the calendar day back in UTC arithmetic, which cannot land on an invalid date.
  const yesterday = new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - 86_400_000);
  const wall = Date.UTC(
    yesterday.getUTCFullYear(),
    yesterday.getUTCMonth(),
    yesterday.getUTCDate(),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );

  /*
    Convert that wall clock back to an instant: guess, then correct by how far the guess
    lands from the wall clock in this zone. Same as the export importer — the offset is not
    knowable without asking, and a hardcoded one is wrong for half the year.
  */
  const seen = formatter(WITHOUT_SECONDS, timeZone, false).formatToParts(new Date(wall));
  const at2 = (type: string): number => Number(seen.find((p) => p.type === type)?.value ?? 0);
  const asLocal = Date.UTC(at2('year'), at2('month') - 1, at2('day'), at2('hour') % 24, at2('minute'));
  return new Date(wall + (wall - asLocal));
}

/**
 * Attach yesterday's reading to each of today's, or null where there is none. `history` must
 * reach back far enough to contain yesterday; readings outside the window never match.
 */
export function yesterdayFor(
  points: Array<{ t: string }>,
  history: Reading[],
  timeZone: string = SITE_TIMEZONE,
): Array<number | null> {
  const stamps = history
    .map((row) => ({ at: new Date(row.t).getTime(), powerW: row.powerW }))
    .filter((row) => Number.isFinite(row.at))
    .sort((a, b) => a.at - b.at);

  return points.map((point) => {
    const target = sameClockYesterday(new Date(point.t), timeZone).getTime();
    if (!Number.isFinite(target)) return null;
    let best: { dt: number; powerW: number } | null = null;
    for (const row of stamps) {
      const dt = Math.abs(row.at - target);
      // Sorted, so past the window there is nothing better left.
      if (row.at > target + MATCH_WINDOW_MS) break;
      if (dt <= MATCH_WINDOW_MS && (best === null || dt < best.dt)) {
        best = { dt, powerW: row.powerW };
      }
    }
    return best?.powerW ?? null;
  });
}
