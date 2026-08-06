/**
 * Filling a collection gap from a vendor's own export.
 *
 * The dashboard records what it managed to poll. When the machine misses a window — a
 * sleeping laptop, a wifi adapter that dropped at 04:23 and did not come back — the day's
 * kWh survives, because the gateway's counter is cumulative and lives on the gateway. The
 * five-minute power history does not: it has a hole, and nothing but the vendor's own record
 * can fill it.
 *
 * These rules are what make that safe, and none of them are negotiable:
 *
 *  - An imported row is marked `source = 'cloud'`. It is somebody else's measurement, and a
 *    chart that cannot tell it from your own is a chart nobody can audit.
 *  - Nothing is written where a real reading already sits, so an import cannot overwrite what
 *    the app actually observed and running it twice is a no-op rather than a duplicate.
 *  - Energy is integrated from the power in the export rather than read from it. Every
 *    imported value therefore lands below the gateway's own daily counter, which means an
 *    import is arithmetically incapable of inflating the day's total — the one number that
 *    was never damaged in the first place.
 *
 * This lived in a CLI script for a while, which was fine until somebody needed it on a
 * Raspberry Pi: the release ships a single executable with no Node and no Prisma, so the
 * documented way to repair a gap could not be run on the machines that have them.
 */

/** Anything within this of an existing reading counts as already covered. */
export const NEAR_MS = 150_000;

/** The interval the vendor exports at, for integrating power into energy. */
export const SAMPLE_MINUTES = 5;

export interface CloudPoint {
  /** The instant, resolved against the site's timezone. */
  at: Date;
  watts: number;
  /** The local date this belongs to, as the readings table stores it. */
  localDate: string;
}

export interface ParseResult {
  points: CloudPoint[];
  /** Every local date the export touches, in order. */
  dates: string[];
  /** Lines that looked like data and could not be read. Reported, never guessed at. */
  rejected: number;
}

/**
 * The UTC instant for a local wall-clock time.
 *
 * Derived by asking Intl what a guessed instant looks like in the zone and correcting by the
 * difference, rather than hardcoding an offset. A fixed -3 would be wrong for half the year,
 * and silently wrong on the two days it changes — which are exactly the days somebody is
 * most likely to be repairing a gap.
 */
export function instantFor(dateStr: string, hhmm: string, zone: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const seen = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(guess));
  const get = (type: string): number => Number(seen.find((p) => p.type === type)?.value ?? 0);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return new Date(guess + (guess - asLocal));
}

const DATE_TIME = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/;
const TIME_ONLY = /^(\d{1,2}:\d{2})$/;

/**
 * Read whatever the export produced.
 *
 * S-Miles puts the plant name in front, which is the owner's street address — so the parser
 * takes the last two cells rather than the first two, and the name is never stored or
 * echoed back. Rows carry either a full timestamp or a bare time; the full form is preferred
 * because it needs no assumption, and `fallbackDate` covers the older shape.
 */
export function parseExport(
  text: string,
  { zone, fallbackDate }: { zone: string; fallbackDate?: string },
): ParseResult {
  const points: CloudPoint[] = [];
  let rejected = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cells = trimmed.split(/\t|\s{2,}|,/).map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;

    const watts = Number(cells[cells.length - 1]);
    // The rest of the line, so a "2026-08-06 05:35" split across cells still matches.
    const stamp = cells.slice(0, -1).join(' ');

    const full = DATE_TIME.exec(stamp);
    let localDate: string | undefined;
    let hhmm: string | undefined;
    if (full) {
      localDate = full[1];
      hhmm = full[2];
    } else {
      const bare = TIME_ONLY.exec(cells[cells.length - 2] ?? '');
      if (bare && fallbackDate) {
        localDate = fallbackDate;
        hhmm = bare[1].padStart(5, '0');
      }
    }

    if (!localDate || !hhmm || !Number.isFinite(watts)) {
      // A header row is not a rejection; a data row we cannot read is.
      if (/^\d/.test(cells[cells.length - 1] ?? '')) rejected += 1;
      continue;
    }
    points.push({ at: instantFor(localDate, hhmm, zone), watts, localDate });
  }

  points.sort((a, b) => a.at.getTime() - b.at.getTime());
  const dates = [...new Set(points.map((p) => p.localDate))].sort();
  return { points, dates, rejected };
}

export interface PlannedRow {
  at: Date;
  localDate: string;
  watts: number;
  /** Integrated from the power above, never taken from the export. */
  dailyEnergy: number;
}

export interface ImportPlan {
  insert: PlannedRow[];
  /** Points refused because a real reading already covers that moment. */
  covered: number;
  dates: string[];
  rejected: number;
  /** Highest energy this import would write per day, against what is already recorded. */
  perDay: Array<{ date: string; rows: number; importedPeakWh: number; recordedPeakWh: number }>;
}

/**
 * Decide what would be written, without writing it.
 *
 * Separated from the writing so the same answer can be shown to somebody before they commit
 * to it. An import that reports what it did afterwards is not the same as one that says what
 * it will do first, and this is a table nobody wants to repair by hand.
 */
export function planImport(
  points: CloudPoint[],
  existing: Array<{ takenAt: Date; localDate: string; dailyEnergy: number }>,
): ImportPlan {
  const dates = [...new Set(points.map((p) => p.localDate))].sort();

  /*
    Energy restarts at each local date, because the counter it shadows does. Integrating
    straight through midnight would hand the second day a head start it never had.
  */
  const rows: PlannedRow[] = [];
  for (const date of dates) {
    const ofDay = points.filter((p) => p.localDate === date);
    let wh = 0;
    ofDay.forEach((point, index) => {
      if (index > 0) {
        wh += ((ofDay[index - 1].watts + point.watts) / 2) * (SAMPLE_MINUTES / 60);
      }
      rows.push({ at: point.at, localDate: date, watts: point.watts, dailyEnergy: Math.round(wh) });
    });
  }

  const stamps = existing.map((row) => new Date(row.takenAt).getTime());
  const isCovered = (at: Date): boolean =>
    stamps.some((stamp) => Math.abs(stamp - at.getTime()) < NEAR_MS);

  const insert = rows.filter((row) => !isCovered(row.at));

  const perDay = dates.map((date) => {
    const mine = insert.filter((row) => row.localDate === date);
    const recorded = existing.filter((row) => row.localDate === date);
    return {
      date,
      rows: mine.length,
      importedPeakWh: mine.reduce((max, row) => Math.max(max, row.dailyEnergy), 0),
      recordedPeakWh: recorded.reduce((max, row) => Math.max(max, row.dailyEnergy), 0),
    };
  });

  return { insert, covered: rows.length - insert.length, dates, rejected: 0, perDay };
}
