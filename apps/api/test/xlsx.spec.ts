import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSheet, serialToDate } from '../src/readings/xlsx';

/*
  Checked against a real utility export rather than a file this project wrote: a round trip
  through our own writer would only prove the reader agrees with itself, not that it handles
  another tool's zip and worksheet layout.
*/

const FIXTURE = join(__dirname, 'fixtures', 'utility-usage-nbpower.xlsx');
const rows = (): ReturnType<typeof readSheet> => readSheet(readFileSync(FIXTURE));

describe('readSheet, on a real utility export', () => {
  it('reads the header block and the table', () => {
    const grid = rows();
    expect(grid.length).toBeGreaterThan(30);
    expect(String(grid[0][0])).toContain('Meter Number');
    expect(String(grid[4][0])).toBe('Date');
    expect(String(grid[4][1])).toContain('NB Power Supplied');
    expect(String(grid[4][2])).toContain('Customer Supplied');
  });

  it('reads numbers as numbers', () => {
    // The first data row: 90 kWh supplied, nothing exported.
    const first = rows()[5];
    expect(first[1]).toBe(90);
    expect(first[2]).toBe(0);
  });

  it('keeps a blank cell as a hole rather than shifting the row left', () => {
    // An empty export column would otherwise slide the validation status into the
    // kilowatt-hour position, where it still looks like a plausible number.
    for (const row of rows().slice(5)) {
      if (row[0] === null) continue;
      expect(row.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('finds the day the meter started counting export', () => {
    // Nothing credited before the 27th in this export.
    const data = rows()
      .slice(5)
      .filter((row) => typeof row[0] === 'number' && serialToDate(row[0] as number) !== null)
      .map((row) => ({ date: serialToDate(row[0] as number)!, exported: Number(row[2]) }));
    const firstExport = data.find((row) => row.exported > 0);
    expect(firstExport?.date).toBe('2026-07-27');
    expect(data.filter((row) => row.exported === 0)).toHaveLength(22);
  });
});

describe('serialToDate', () => {
  it('uses the epoch every spreadsheet agrees on', () => {
    /*
      1899-12-30, not 1900-01-01: Excel reproduces a Lotus leap-year bug deliberately, so the
      offset is correct precisely because it looks wrong. Derived rather than written as a
      magic serial, so the assertion states the rule.
    */
    const serialFor = (iso: string): number =>
      (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(serialToDate(serialFor('2026-08-02'))).toBe('2026-08-02');
    expect(serialToDate(serialFor('2026-07-05'))).toBe('2026-07-05');
  });

  it('leaves a number that cannot be a date alone', () => {
    // A kWh reading is never ~46,000, so the plausible-serial band separates the date column
    // from the value columns without parsing styles.xml for a number format.
    for (const notADate of [0, 90, 141, 1_000_000, Number.NaN]) {
      expect(serialToDate(notADate)).toBeNull();
    }
  });
});
