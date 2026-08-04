/**
 * Reading a utility's own meter data, whatever shape it arrives in.
 *
 * This is the same quantity a clamp on the service entrance measures — energy across the
 * property boundary, in both directions — except the utility already measures it, bills on
 * it, and hands it over on request. Where it exists it outranks anything this app measures
 * for itself, because it is the number the money is calculated from.
 *
 * There is a standard: Green Button (ESPI, NAESB REQ.21), mandated in Ontario since
 * November 2023. Most utilities elsewhere export a table of their own devising. So this
 * reads tables, and does it in three tiers:
 *
 *   1. Recognise the columns from a list of names utilities actually use.
 *   2. Failing that, hand back the headers it found so a person can say which is which.
 *   3. Never guess. A column mapped wrongly turns imports into exports and produces a
 *      savings figure that is confidently backwards.
 *
 * Tier 2 is the part that makes "support other formats" a solved problem rather than a
 * queue of parsers: an unrecognised export is a mapping away from working, not a feature
 * request.
 */

import type { CellValue } from './xlsx';
import { serialToDate } from './xlsx';

/** One day at the meter. Both directions, never netted — the split is the whole point. */
export interface UtilityDay {
  /** YYYY-MM-DD. */
  date: string;
  /** Energy drawn from the grid. */
  importedKwh: number;
  /** Energy sent back. Zero is a measurement; absent is not. */
  exportedKwh: number;
}

export type ColumnRole = 'date' | 'imported' | 'exported' | 'net';

export interface ColumnMapping {
  date: number;
  imported: number;
  exported: number;
  /** Optional: used only to check the other two against the file's own arithmetic. */
  net?: number;
}

/**
 * What utilities call these columns.
 *
 * Ordered most-specific first, and deliberately excluding words that flip meaning with
 * point of view. "Delivered" is the utility delivering to you on one bill and you
 * delivering to them on another; "generation" is the array's output on some exports and
 * the surplus that reached the grid on others. Matching either would produce a clean
 * import that is inside out, so both are left to the mapping step where a person can look
 * at the numbers and decide.
 */
const HEADER_HINTS: Record<ColumnRole, RegExp[]> = {
  date: [/^date$/i, /reading\s*date/i, /usage\s*date/i, /interval\s*start/i, /^day$/i],
  imported: [
    /supplied\s*by/i,
    /\bpower\s*supplied\b/i,
    /from\s*grid/i,
    /grid\s*(import|supplied|purchase)/i,
    /\bimport(ed)?\b/i,
    /\bconsum(ed|ption)\b/i,
    /\bpurchased\b/i,
    /\boff[\s-]?peak\s*consum/i,
  ],
  exported: [
    /customer\s*supplied/i,
    /to\s*grid/i,
    /grid\s*(export|receipt|received)/i,
    /\bexport(ed)?\b/i,
    /\breceived\b/i,
    /\bsurplus\b/i,
    /net\s*generation/i,
  ],
  net: [/^net\b/i, /net\s*(usage|consumption|metered)/i],
};

const text = (cell: CellValue): string => (cell === null ? '' : String(cell)).trim();

/** Which role a header names, if any. Ambiguous headers match nothing on purpose. */
export function roleOf(header: string): ColumnRole | null {
  const trimmed = header.trim();
  if (!trimmed) return null;
  /*
    Net is tested first. "Net usage" contains "usage", which some consumption patterns
    would otherwise claim — and a net column read as consumption is negative on the good
    days, which looks like a meter fault rather than a mapping error.
  */
  for (const role of ['net', 'exported', 'imported', 'date'] as ColumnRole[]) {
    if (HEADER_HINTS[role].some((pattern) => pattern.test(trimmed))) return role;
  }
  return null;
}

export interface Detection {
  /** The row the headers were found on, or null when none was recognised. */
  headerRow: number | null;
  mapping: ColumnMapping | null;
  /** Every header seen on the best candidate row — what a mapping UI offers. */
  headers: string[];
}

/**
 * Find the header row and map its columns.
 *
 * Scans rather than assuming row one: a utility export opens with a meter number, an
 * account number and a billing period before the table starts, and those preamble lines
 * are not a header even though they are the first thing in the file.
 */
export function detectColumns(grid: CellValue[][]): Detection {
  let best: Detection = { headerRow: null, mapping: null, headers: [] };
  for (const [index, row] of grid.entries()) {
    const headers = row.map(text);
    const roles = new Map<ColumnRole, number>();
    for (const [column, header] of headers.entries()) {
      const role = roleOf(header);
      // First match wins, so a later "Net usage" cannot displace a real reading column.
      if (role && !roles.has(role)) roles.set(role, column);
    }
    const date = roles.get('date');
    const imported = roles.get('imported');
    const exported = roles.get('exported');
    if (date !== undefined && imported !== undefined && exported !== undefined) {
      return {
        headerRow: index,
        mapping: { date, imported, exported, net: roles.get('net') },
        headers,
      };
    }
    // Keep the richest row seen, so an unrecognised file still offers something to map.
    if (headers.filter(Boolean).length > best.headers.filter(Boolean).length) {
      best = { headerRow: null, mapping: null, headers };
    }
  }
  return best;
}

/** A date cell, however the file chose to express one. Null when it is not a date. */
export function readDate(cell: CellValue): string | null {
  if (typeof cell === 'number') return serialToDate(cell);
  const raw = text(cell);
  if (!raw) return null;
  // ISO first — unambiguous, and what every export examined so far actually writes.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  /*
    Anything else is refused. 03/04/2026 is the third of April in most of the world and
    the fourth of March in one country, and nothing in the cell says which — a file read
    the wrong way round produces a year of readings on plausible but wrong dates, and
    nothing downstream can tell. A mapping step can ask; a regex cannot.
  */
  return null;
}

const number = (cell: CellValue): number | null => {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  const raw = text(cell).replace(/[, ]/g, '');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

export interface ParseResult {
  readings: UtilityDay[];
  /** Rows that looked like data but could not be read, with why. */
  problems: string[];
}

/**
 * Turn a grid into daily readings using a column mapping.
 *
 * Rows that cannot be read are reported rather than skipped. A usage import that quietly
 * drops a third of its rows produces a self-consumption figure computed over a window
 * nobody chose, and every number after it inherits that.
 */
export function parseRows(grid: CellValue[][], mapping: ColumnMapping, startRow: number): ParseResult {
  const readings: UtilityDay[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (let index = startRow; index < grid.length; index++) {
    const row = grid[index];
    if (!row || row.every((cell) => cell === null || text(cell) === '')) continue;

    const date = readDate(row[mapping.date] ?? null);
    if (!date) {
      // Totals and footers land here, which is why this is a note rather than a failure.
      problems.push(`row ${index + 1}: no readable date`);
      continue;
    }
    const imported = number(row[mapping.imported] ?? null);
    const exported = number(row[mapping.exported] ?? null);
    if (imported === null || exported === null) {
      problems.push(`row ${index + 1} (${date}): missing a reading`);
      continue;
    }
    if (imported < 0 || exported < 0) {
      /*
        Both columns are magnitudes; a negative in either means the file is not shaped the
        way the mapping claims — most often a net column mapped as one direction. Refused,
        because the alternative is a self-consumption figure that is confidently backwards.
      */
      problems.push(`row ${index + 1} (${date}): negative reading — check the column mapping`);
      continue;
    }
    if (mapping.net !== undefined) {
      const net = number(row[mapping.net] ?? null);
      // The file's own arithmetic, used as a check on the mapping rather than as data.
      if (net !== null && Math.abs(imported - exported - net) > 1) {
        problems.push(
          `row ${index + 1} (${date}): ${imported} − ${exported} is not the ${net} this file calls net`,
        );
        continue;
      }
    }
    if (seen.has(date)) {
      problems.push(`row ${index + 1}: ${date} appears more than once`);
      continue;
    }
    seen.add(date);
    readings.push({ date, importedKwh: imported, exportedKwh: exported });
  }
  readings.sort((a, b) => a.date.localeCompare(b.date));
  return { readings, problems };
}

export interface UnmeteredDay {
  date: string;
  producedKwh: number;
}

/**
 * Days the array produced and the meter recorded no export at all.
 *
 * This is not a rounding case. A day with real production and a hard zero in the export
 * column almost always means the meter was not counting export yet — a net-metering
 * agreement that had not been activated, or a unidirectional meter still in place. Taken
 * at face value it reads as *perfect* self-consumption, which would credit the house with
 * every kilowatt-hour it actually gave away, and inflate the savings figure at exactly the
 * moment the owner was being short-changed.
 *
 * Named rather than corrected, because the app cannot know which it was. What it can do is
 * refuse to average those days into a self-consumption number and say why.
 */
export function unmeteredDays(
  readings: UtilityDay[],
  producedKwhByDate: Map<string, number>,
  /** Below this, a day's production is too small to distinguish from a meter's rounding. */
  minProducedKwh = 5,
): UnmeteredDay[] {
  const out: UnmeteredDay[] = [];
  for (const reading of readings) {
    if (reading.exportedKwh > 0) continue;
    const produced = producedKwhByDate.get(reading.date);
    if (produced !== undefined && produced >= minProducedKwh) {
      out.push({ date: reading.date, producedKwh: produced });
    }
  }
  return out;
}

/** One sentence a person can act on, or null when there is nothing to report. */
export function describeUnmetered(days: UnmeteredDay[]): string | null {
  if (days.length === 0) return null;
  const total = days.reduce((sum, day) => sum + day.producedKwh, 0);
  const first = days[0].date;
  const last = days[days.length - 1].date;
  const when = first === last ? first : `${first} to ${last}`;
  return (
    `${days.length} day${days.length === 1 ? '' : 's'} (${when}) produced ${total.toFixed(0)} kWh ` +
    'while the meter recorded no export at all. That is not self-consumption — it is a meter ' +
    'that was not counting what left the property, usually a net-metering agreement that had ' +
    'not been activated yet. Those days are excluded from measured self-consumption, and the ' +
    'export is worth raising with the utility.'
  );
}
