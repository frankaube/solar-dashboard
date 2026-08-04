import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSheet, serialToDate } from '../src/readings/xlsx';

/*
  Checked against a real utility export rather than a file this project wrote.

  A round trip through our own writer would prove only that the reader agrees with itself.
  The failure this guards is the one that matters: some other tool's zip, some other tool's
  idea of how to lay out a worksheet, arriving from a customer portal nobody here controls.
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
    /*
      The bug this prevents is silent: an export column that is empty on some rows would
      slide the validation status into the kilowatt-hour position, and every value after it
      would still look like a plausible number.
    */
    for (const row of rows().slice(5)) {
      if (row[0] === null) continue;
      expect(row.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('finds the day the meter started counting export', () => {
    // The whole reason this file was opened: nothing credited before the 27th.
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
      1899-12-30, not 1900-01-01: Excel reproduces a Lotus leap-year bug on purpose, so the
      offset is correct precisely because it looks wrong. Derived here rather than written
      as a magic serial, so the assertion states the rule instead of a number that could
      only be checked by applying it.
    */
    const serialFor = (iso: string): number =>
      (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(serialToDate(serialFor('2026-08-02'))).toBe('2026-08-02');
    expect(serialToDate(serialFor('2026-07-05'))).toBe('2026-07-05');
  });

  it('leaves a number that cannot be a date alone', () => {
    /*
      A kilowatt-hour reading is never 46,000, so the band separates the date column from
      the value columns without parsing styles.xml to resolve a number format. Outside it,
      null — a misread then surfaces as an unreadable date rather than a reading in 4000.
    */
    for (const notADate of [0, 90, 141, 1_000_000, Number.NaN]) {
      expect(serialToDate(notADate)).toBeNull();
    }
  });
});
