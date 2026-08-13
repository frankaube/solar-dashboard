import { SITE_TIMEZONE } from '../common/localdate';

/**
 * What the array was doing at this time yesterday.
 *
 * The expected-vs-actual chart answers "is the roof keeping up with the sky". The question
 * it raises and does not answer is "compared to what" — a 10.7 kW morning means one thing
 * after a clear day and another after a wet one, and the owner has the comparison in their
 * head anyway. This puts it in the tooltip.
 *
 * MATCHED ON THE CLOCK, NOT ON THE ELAPSED HOURS. "Yesterday at 11:07" and "24 hours ago"
 * are the same instant on 363 days a year and an hour apart on the other two. For a solar
 * curve that hour is not a rounding difference — it is a different sun angle, which is the
 * whole basis of the comparison. So the target is rebuilt from the wall clock in the site's
 * own timezone.
 *
 * Nothing is interpolated. If yesterday has no reading near that moment — the collector was
 * down, the machine was asleep — the answer is null and the tooltip omits the line. A
 * comparison against a number nobody measured is worse than no comparison, because it looks
 * like one.
 */

/** How close a reading has to be to count as "that moment". Samples arrive every five. */
export const MATCH_WINDOW_MS = 6 * 60_000;

export interface Reading {
  t: string;
  powerW: number;
}

/*
  Formatters, built once per timezone.

  `new Intl.DateTimeFormat(...)` is expensive — an order of magnitude more than the format
  call it enables. Constructing two of them inside this function meant building 564 of them
  to draw one day's chart, which measured 24 ms against 2.3 ms hoisted on a desktop and
  rather worse on the Pi this runs on. A tiny map because the zone is a parameter; in
  practice it holds one entry.
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
 * The instant one local day earlier, at the same wall-clock time.
 *
 * Built by asking Intl what the instant looks like in the zone, stepping the date back a
 * day, and converting that wall clock back to an instant. A flat subtraction of 24 hours
 * would drift by an hour across a daylight-saving boundary.
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
    Convert that wall clock back to a real instant.

    Guessed, then corrected by how far the guess actually lands from the wall clock in this
    zone — the same trick the export importer uses, and for the same reason: the offset is
    not knowable without asking, and hardcoding one is wrong for half the year.
  */
  const seen = formatter(WITHOUT_SECONDS, timeZone, false).formatToParts(new Date(wall));
  const at2 = (type: string): number => Number(seen.find((p) => p.type === type)?.value ?? 0);
  const asLocal = Date.UTC(at2('year'), at2('month') - 1, at2('day'), at2('hour') % 24, at2('minute'));
  return new Date(wall + (wall - asLocal));
}

/**
 * Attach yesterday's reading to each of today's, or null where there is none.
 *
 * `history` should reach back far enough to contain yesterday; readings outside the window
 * are simply never matched. Linear rather than clever because a day of five-minute samples
 * is a few hundred points and the sorted-window version would be harder to read than it is
 * worth.
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
      // Sorted, so once the gap starts growing past the window there is nothing better left.
      if (row.at > target + MATCH_WINDOW_MS) break;
      if (dt <= MATCH_WINDOW_MS && (best === null || dt < best.dt)) {
        best = { dt, powerW: row.powerW };
      }
    }
    return best?.powerW ?? null;
  });
}
