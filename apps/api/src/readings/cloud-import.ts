/**
 * Filling a collection gap from a vendor's own export.
 *
 * A missed polling window leaves the day's kWh intact — the counter is cumulative and lives
 * on the gateway — but holes the five-minute power history. Three rules make the fill safe:
 *
 *  - An imported row is marked `source = 'cloud'`, so it can be told from an observed one.
 *  - Nothing is written where a real reading already sits, so running it twice is a no-op.
 *  - Energy is integrated from the export's power rather than read from it, so an imported
 *    value always lands below the gateway's own counter and cannot inflate the day.
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
 * The UTC instant for a local wall-clock time. Derived by asking Intl what a guessed instant
 * looks like in the zone and correcting by the difference — a hardcoded offset is wrong for
 * half the year and on the two changeover days.
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
 * S-Miles puts the plant name first, which is the owner's street address — so this takes the
 * last two cells rather than the first two, and never stores or echoes the name. Rows carry
 * either a full timestamp or a bare time; `fallbackDate` covers the latter.
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

/** Decide what would be written, without writing it, so it can be previewed first. */
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
