import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSheet } from '../src/readings/xlsx';
import {
  describeUncomparable,
  describeUnmetered,
  detectColumns,
  parseRows,
  readDate,
  roleOf,
  uncomparableDays,
  unmeteredDays,
} from '../src/readings/utility-usage';

/*
  The load-bearing behaviour is refusal. A column mapped the wrong way round turns imports
  into exports and every individual number stays plausible, so an unrecognised header maps
  to nothing and a row that fails the file's own arithmetic is reported, not absorbed.
*/

const FIXTURE = join(__dirname, 'fixtures', 'utility-usage-nbpower.xlsx');
const grid = (): ReturnType<typeof readSheet> => readSheet(readFileSync(FIXTURE));

describe('on a real utility export', () => {
  it('finds the header row past the account preamble', () => {
    // The file opens with a meter number, an account number and a billing period.
    const detection = detectColumns(grid());
    expect(detection.headerRow).toBe(4);
    expect(detection.mapping).toEqual({ date: 0, imported: 1, exported: 2, net: 3 });
  });

  it('reads every day in the period', () => {
    const detection = detectColumns(grid());
    const { readings, problems } = parseRows(grid(), detection.mapping!, detection.headerRow! + 1);
    expect(readings).toHaveLength(29);
    expect(readings[0]).toEqual({ date: '2026-07-05', importedKwh: 90, exportedKwh: 0 });
    expect(readings.at(-1)).toEqual({ date: '2026-08-02', importedKwh: 28, exportedKwh: 56 });
    expect(problems).toEqual([]);
  });

  it('checks itself against the file s own net column', () => {
    // 63 − 83 = −20 and the file agrees: an independent check that the two reading
    // columns were not mapped the wrong way round.
    const detection = detectColumns(grid());
    const swapped = { ...detection.mapping!, imported: 2, exported: 1 };
    const { readings, problems } = parseRows(grid(), swapped, detection.headerRow! + 1);
    expect(readings.length).toBeLessThan(10);
    expect(problems.join(' ')).toContain('is not the');
  });
});

describe('roleOf', () => {
  it('recognises the names utilities actually use', () => {
    expect(roleOf('Date')).toBe('date');
    expect(roleOf('NB Power Supplied (kWh)')).toBe('imported');
    expect(roleOf('Customer Supplied (kWh)')).toBe('exported');
    expect(roleOf('Net usage')).toBe('net');
    expect(roleOf('Energy Exported (kWh)')).toBe('exported');
    expect(roleOf('Consumption')).toBe('imported');
  });

  it('refuses words that flip meaning with point of view', () => {
    /*
      "Delivered" is the utility delivering to you on one bill and you delivering to them on
      another; "Generation" is array output on some exports and grid surplus on others.
    */
    expect(roleOf('Delivered')).toBeNull();
    expect(roleOf('Generation (kWh)')).toBeNull();
    expect(roleOf('Reading')).toBeNull();
    expect(roleOf('')).toBeNull();
  });

  it('reads net before usage, so a net column is not taken for consumption', () => {
    // Mapped as consumption it is negative on the good days, which reads as a meter fault.
    expect(roleOf('Net usage')).toBe('net');
    expect(roleOf('Net metered consumption')).toBe('net');
  });
});

describe('detectColumns on a file it does not know', () => {
  it('maps nothing and offers the headers instead', () => {
    const unknown = [
      ['Meter', 'Period'],
      ['Timestamp', 'Delivered', 'Generation', 'Notes'],
      ['2026-07-05', 90, 0, ''],
    ];
    const detection = detectColumns(unknown);
    expect(detection.mapping).toBeNull();
    expect(detection.headers).toEqual(['Timestamp', 'Delivered', 'Generation', 'Notes']);
  });
});

describe('readDate', () => {
  it('takes ISO, which is what these exports actually write', () => {
    expect(readDate('2026-07-27')).toBe('2026-07-27');
    expect(readDate('2026-07-27 00:00:00')).toBe('2026-07-27');
  });

  it('refuses an ambiguous slash date rather than picking a hemisphere', () => {
    // 03/04/2026 is 3 April in most of the world and 4 March in the US, and nothing in the
    // cell says which.
    expect(readDate('03/04/2026')).toBeNull();
    expect(readDate('not a date')).toBeNull();
    expect(readDate(null)).toBeNull();
  });
});

describe('parseRows', () => {
  const mapping = { date: 0, imported: 1, exported: 2 };

  it('reports a row it cannot read instead of dropping it', () => {
    const { readings, problems } = parseRows(
      [['Date', 'In', 'Out'], ['2026-07-05', 90, 0], ['Totals', 2540, 339], ['2026-07-06', 98, null]],
      mapping,
      1,
    );
    expect(readings).toHaveLength(1);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toContain('missing a reading');
  });

  it('refuses a negative reading', () => {
    const { readings, problems } = parseRows([['2026-07-05', 90, -20]], mapping, 0);
    expect(readings).toEqual([]);
    expect(problems[0]).toContain('check the column mapping');
  });

  it('refuses a duplicated day rather than counting it twice', () => {
    const { readings, problems } = parseRows(
      [['2026-07-05', 90, 0], ['2026-07-05', 91, 0]],
      mapping,
      0,
    );
    expect(readings).toHaveLength(1);
    expect(problems[0]).toContain('appears more than once');
  });

  it('keeps a real zero', () => {
    // A day that exported nothing is a measurement; absent is not.
    const { readings } = parseRows([['2026-07-05', 90, 0]], mapping, 0);
    expect(readings[0].exportedKwh).toBe(0);
  });
});

describe('unmeteredDays', () => {
  /** What the array actually made on the days before the meter started counting. */
  const produced = new Map([
    ['2026-07-23', 40.0],
    ['2026-07-24', 109.9],
    ['2026-07-25', 108.1],
    ['2026-07-26', 109.3],
    ['2026-07-27', 106.9],
  ]);

  it('catches production the meter recorded no export for', () => {
    // Production with a zero export column reads as perfect self-consumption and inflates
    // savings, so those days are flagged rather than counted.
    const readings = [
      { date: '2026-07-23', importedKwh: 86, exportedKwh: 0 },
      { date: '2026-07-24', importedKwh: 94, exportedKwh: 0 },
      { date: '2026-07-25', importedKwh: 112, exportedKwh: 0 },
      { date: '2026-07-26', importedKwh: 78, exportedKwh: 0 },
      { date: '2026-07-27', importedKwh: 63, exportedKwh: 83 },
    ];
    const flagged = unmeteredDays(readings, produced);
    expect(flagged.map((d) => d.date)).toEqual(['2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26']);
    expect(describeUnmetered(flagged)).toContain('367 kWh');
    expect(describeUnmetered(flagged)).toContain('not self-consumption');
  });

  it('ignores a day before the array existed', () => {
    // No production means a zero export column is simply true.
    const readings = [{ date: '2026-07-05', importedKwh: 90, exportedKwh: 0 }];
    expect(unmeteredDays(readings, produced)).toEqual([]);
  });

  it('ignores a barely-producing day, where zero export is plausible', () => {
    const readings = [{ date: '2026-07-30', importedKwh: 46, exportedKwh: 0 }];
    expect(unmeteredDays(readings, new Map([['2026-07-30', 2.1]]))).toEqual([]);
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeUnmetered([])).toBeNull();
  });
});

/*
  A utility export reaches back to the meter's installation while this app's record starts
  when it was switched on. Days before that are stored and counted in the import total, but
  skipped by every calculation, so they have to be named.
*/
describe('uncomparableDays', () => {
  const produced = new Map([
    ['2026-07-23', 40.0],
    ['2026-07-24', 109.9],
    ['2026-07-25', 108.1],
  ]);

  it('names the days this app has no production for', () => {
    const readings = [
      { date: '2026-07-21', importedKwh: 90, exportedKwh: 12 },
      { date: '2026-07-22', importedKwh: 88, exportedKwh: 9 },
      { date: '2026-07-23', importedKwh: 86, exportedKwh: 31 },
      { date: '2026-07-24', importedKwh: 94, exportedKwh: 77 },
    ];
    expect(uncomparableDays(readings, produced)).toEqual(['2026-07-21', '2026-07-22']);
  });

  it('counts a zero-production day too, because the filter downstream is > 0', () => {
    // `savings.service` keeps days where energyWh > 0, so a recorded-but-empty day is as
    // uncomparable as a missing one.
    const readings = [{ date: '2026-07-30', importedKwh: 46, exportedKwh: 0 }];
    expect(uncomparableDays(readings, new Map([['2026-07-30', 0]]))).toEqual(['2026-07-30']);
  });

  it('is empty when every day can be compared', () => {
    const readings = [{ date: '2026-07-23', importedKwh: 86, exportedKwh: 31 }];
    expect(uncomparableDays(readings, produced)).toEqual([]);
  });
});

describe('describeUncomparable', () => {
  it('says how many, over what span, and why', () => {
    const note = describeUncomparable(['2026-07-14', '2026-07-22'], '2026-07-23');
    expect(note).toContain('2 days');
    expect(note).toContain('2026-07-14 to 2026-07-22');
    expect(note).toContain('record starts on 2026-07-23');
    expect(note).toContain('still stored');
  });

  it('reads correctly for a single day', () => {
    const note = describeUncomparable(['2026-07-14'], '2026-07-23');
    expect(note).toContain('1 day (2026-07-14) has');
    expect(note).not.toContain('1 days');
  });

  it('handles an install with no production at all rather than naming a null date', () => {
    const note = describeUncomparable(['2026-07-14'], null);
    expect(note).toContain('no production record at all yet');
    expect(note).not.toContain('null');
  });

  it('says nothing when every day counts', () => {
    expect(describeUncomparable([], '2026-07-23')).toBeNull();
  });
});
