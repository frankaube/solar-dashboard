/**
 * Just enough of the XLSX container to read a table out of it.
 *
 * An .xlsx is a zip of XML, and the part anyone needs from a utility export is one
 * worksheet plus the shared-string table. Node already ships the hard half — `zlib` does
 * the decompression — so what remains is walking a zip's central directory and pulling two
 * entries out of it. That is roughly a hundred lines against a library measured in
 * megabytes, on a project that ships as a single binary to a Raspberry Pi.
 *
 * Deliberately narrow. It reads cell values as strings and numbers and stops there: no
 * formulas, no styles, no merged cells, no formatting. A utility usage export is a header
 * row and a column of dates, and anything richer than that is not the file we are here for.
 */

import { inflateRawSync } from 'node:zlib';

/** End of central directory record — scanned for from the back, as the format intends. */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/**
 * Excel counts days from 1899-12-30 rather than 1900-01-01, because it deliberately
 * reproduces a Lotus 1-2-3 bug that treats 1900 as a leap year. Every spreadsheet on earth
 * agrees on the wrong epoch, so the offset below is correct precisely because it is odd.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
/**
 * The band of serial numbers that are plausibly dates in a usage export: 1990 to 2100.
 *
 * Needed because reading the real cell format means parsing styles.xml and resolving a
 * number-format id, and a utility export's date column is unambiguous without it — a
 * kilowatt-hour reading is never 46,000. Values outside the band are left as numbers, so a
 * misread shows up as an unparseable date rather than as a reading in the year 4000.
 */
const SERIAL_MIN = 32_874;
const SERIAL_MAX = 73_050;

export type CellValue = string | number | null;

/** Read every file in a zip archive into memory. Utility exports are a few kilobytes. */
function unzip(buffer: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // The EOCD is at the end, after a comment of unknown length, so scan backwards for it.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    /*
      The local header repeats the name and extra fields with its OWN lengths, which need
      not match the central directory's. Reading the data at a fixed offset from the local
      header is the classic zip bug: it works on files written by one tool and produces
      garbage on files written by another.
    */
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** Unescape the five XML entities. Utility exports carry ampersands in meter labels. */
const unescapeXml = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/*
  Every element pattern below tolerates a namespace prefix.

  Excel writes `<row>` and `<c>`; the export that prompted this file writes `<x:row>` and
  `<x:c>`, because the generator declared the spreadsheet namespace as a prefix rather than
  the default. Both are correct XML and a reader that assumes either one silently returns
  an empty sheet from the other — no error, no clue, just a file that appears to contain
  nothing. Which is exactly how this was found.
*/
const RE_SI = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
const RE_T = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
const RE_ROW = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g;
/** Self-closing or paired: `<c … />` is an empty cell, and both forms appear in one file. */
const RE_CELL = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
const RE_V = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/;

/** The shared-string table: `<si>` entries, each possibly split across several `<t>` runs. */
function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const [, si] of xml.matchAll(RE_SI)) {
    const runs = [...si.matchAll(RE_T)].map((m) => m[1]);
    out.push(unescapeXml(runs.join('')));
  }
  return out;
}

/** "BC12" → 12. Column letters are base-26 with no zero, so A is 1 rather than 0. */
function columnOf(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? 'A';
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column;
}

/** An Excel serial in the plausible band, as an ISO date. Anything else stays a number. */
export function serialToDate(value: number): string | null {
  if (!Number.isFinite(value) || value < SERIAL_MIN || value > SERIAL_MAX) return null;
  const at = new Date(EXCEL_EPOCH_MS + Math.round(value) * MS_PER_DAY);
  return at.toISOString().slice(0, 10);
}

/**
 * Every row of the first worksheet, as a ragged grid.
 *
 * Blank cells inside a row become null rather than being skipped, because a usage export
 * with an empty export column must not silently shift its remaining values one place left.
 */
export function readSheet(buffer: Buffer): CellValue[][] {
  const files = unzip(buffer);
  const sheetName = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];
  if (!sheetName) throw new Error('no worksheet found');

  const strings = sharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
  const xml = files.get(sheetName)!.toString('utf8');

  const rows: CellValue[][] = [];
  for (const match of xml.matchAll(RE_ROW)) {
    const rowXml = match[2];
    /*
      Placed by its `r` attribute, not by the order it appears.

      A writer omits empty rows entirely — this file has no element at all for the blank
      line above its header — so appending in document order silently shifts every row
      after the gap up by one. The header lands where the first reading should be, and the
      whole table still parses cleanly into numbers that are one day out. Exactly the same
      failure as ignoring a cell's column, one dimension up.
    */
    const declared = Number(/\br="(\d+)"/.exec(match[1] ?? '')?.[1]);
    const position = Number.isFinite(declared) && declared > 0 ? declared - 1 : rows.length;
    while (rows.length < position) rows.push([]);

    const row: CellValue[] = [];
    for (const cell of rowXml.matchAll(RE_CELL)) {
      const attributes = cell[1] ?? '';
      const body = cell[2] ?? '';
      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1];
      const type = /t="([^"]+)"/.exec(attributes)?.[1];
      const index = reference ? columnOf(reference) - 1 : row.length;
      while (row.length < index) row.push(null);

      let value: CellValue = null;
      if (type === 'inlineStr') {
        const runs = [...body.matchAll(RE_T)].map((m) => m[1]);
        value = runs.length ? unescapeXml(runs.join('')) : null;
      } else {
        const raw = RE_V.exec(body)?.[1];
        if (raw !== undefined) {
          if (type === 's') value = strings[Number(raw)] ?? null;
          else if (type === 'str' || type === 'e') value = unescapeXml(raw);
          else {
            const numeric = Number(raw);
            value = Number.isFinite(numeric) ? numeric : unescapeXml(raw);
          }
        }
      }
      row[index] = value;
    }
    rows[position] = row;
  }
  return rows;
}
