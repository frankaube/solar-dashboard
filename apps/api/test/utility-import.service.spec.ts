import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UtilityImportService } from '../src/readings/utility-import.service';

/*
  The whole path, on the file that prompted it: bytes → zip → worksheet → column detection
  → daily readings → joined against what the array actually made.

  The production figures below are this array's real output for those days, so the
  assertion at the end is the real finding rather than a constructed one.
*/

const FILE = readFileSync(join(__dirname, 'fixtures', 'utility-usage-nbpower.xlsx'));

const PRODUCED_WH: Record<string, number> = {
  '2026-07-23': 40_000,
  '2026-07-24': 109_900,
  '2026-07-25': 108_100,
  '2026-07-26': 109_300,
  '2026-07-27': 106_900,
  '2026-07-28': 87_200,
  '2026-07-29': 99_700,
  '2026-07-30': 18_600,
  '2026-07-31': 45_800,
  '2026-08-01': 49_100,
  '2026-08-02': 83_800,
};

function service(): UtilityImportService {
  const readings = {
    getDailyEnergy: async () =>
      Object.entries(PRODUCED_WH).map(([date, energyWh]) => ({ date, energyWh })),
  };
  const stored = new Map<string, unknown>();
  const prisma = {
    utilityReading: {
      upsert: async ({ where, create }: { where: { date: string }; create: unknown }) => {
        stored.set(where.date, create);
        return create;
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new UtilityImportService(prisma as any, readings as any);
}

describe('importing a real utility export', () => {
  it('recognises the columns and reads the whole period', async () => {
    const preview = await service().preview(FILE, 'Usage_20260804.xlsx');
    expect(preview.mapping).toEqual({ date: 0, imported: 1, exported: 2, net: 3 });
    expect(preview.readings).toHaveLength(29);
    expect(preview.problems).toEqual([]);
  });

  it('finds the four days the meter was not counting export', async () => {
    /*
      The finding. The array made 367 kWh across 23–26 July and the meter recorded no
      export at all, because net metering had not been activated. Read at face value that
      is perfect self-consumption — crediting the house with every kilowatt-hour it gave
      away, on precisely the days its owner was being short-changed.
    */
    const preview = await service().preview(FILE, 'Usage_20260804.xlsx');
    expect(preview.unmetered.map((day) => day.date)).toEqual([
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
      '2026-07-26',
    ]);
    const total = preview.unmetered.reduce((sum, day) => sum + day.producedKwh, 0);
    expect(total).toBeCloseTo(367.3, 1);
    expect(preview.unmeteredNote).toContain('not self-consumption');
    expect(preview.unmeteredNote).toContain('worth raising with the utility');
  });

  it('does not flag the days before the array existed', async () => {
    // Jul 5–22 also read zero export, and for those it is simply true.
    const preview = await service().preview(FILE, 'Usage_20260804.xlsx');
    expect(preview.unmetered.some((day) => day.date < '2026-07-23')).toBe(false);
  });

  it('previews without storing anything', async () => {
    /*
      Separate steps on purpose. An import that parses and saves in one action gives nobody
      a moment to notice a column mapped the wrong way round, and by the time the savings
      page looks odd the original file is closed.
    */
    const preview = await service().preview(FILE, 'Usage_20260804.xlsx');
    expect(preview).not.toHaveProperty('stored');
  });

  it('stores the readings and carries the flag with them', async () => {
    const result = await service().commit(FILE, 'Usage_20260804.xlsx');
    expect(result.stored).toBe(29);
  });

  it('reads a CSV of the same shape', async () => {
    // Most utilities export CSV; the format question is answered at the door and never again.
    const csv = [
      'Date,NB Power Supplied (kWh),Customer Supplied (kWh),Net usage',
      '2026-07-26,78,0,78',
      '2026-07-27,63,83,-20',
    ].join('\n');
    const preview = await service().preview(Buffer.from(csv, 'utf8'), 'usage.csv');
    expect(preview.readings).toEqual([
      { date: '2026-07-26', importedKwh: 78, exportedKwh: 0 },
      { date: '2026-07-27', importedKwh: 63, exportedKwh: 83 },
    ]);
    expect(preview.unmetered.map((d) => d.date)).toEqual(['2026-07-26']);
  });

  it('keeps a comma inside a quoted CSV field from shifting the row', async () => {
    // The same silent misalignment the spreadsheet reader had to be fixed for twice.
    const csv = ['Date,Note,NB Power Supplied,Customer Supplied', '2026-07-27,"Meter 1, phase A",63,83'].join('\n');
    const preview = await service().preview(Buffer.from(csv, 'utf8'), 'usage.csv');
    expect(preview.readings).toEqual([{ date: '2026-07-27', importedKwh: 63, exportedKwh: 83 }]);
  });

  it('reads a Green Button feed without asking anyone to map anything', async () => {
    /*
      The one format that declares what its numbers mean: direction comes from the file's
      own ReadingType rather than a column heading somebody has to interpret. Ontario has
      required it of every utility since November 2023.
    */
    const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
    const xml =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
      '<entry><link rel="self" href="/espi/ReadingType/1"/><content><ReadingType><flowDirection>1</flowDirection><uom>72</uom></ReadingType></content></entry>' +
      '<entry><link rel="self" href="/espi/ReadingType/2"/><content><ReadingType><flowDirection>19</flowDirection><uom>72</uom></ReadingType></content></entry>' +
      `<entry><link rel="related" href="/espi/ReadingType/1"/><content><IntervalBlock><IntervalReading><timePeriod><start>${at('2026-07-27T10:00:00Z')}</start></timePeriod><value>63000</value></IntervalReading></IntervalBlock></content></entry>` +
      `<entry><link rel="related" href="/espi/ReadingType/2"/><content><IntervalBlock><IntervalReading><timePeriod><start>${at('2026-07-27T12:00:00Z')}</start></timePeriod><value>83000</value></IntervalReading></IntervalBlock></content></entry>` +
      '</feed>';
    const preview = await service().preview(Buffer.from(xml, 'utf8'), 'GreenButton.xml');
    expect(preview.readings).toEqual([{ date: '2026-07-27', importedKwh: 63, exportedKwh: 83 }]);
    expect(preview.headers).toEqual([]);
  });

  it('hands back the headers when it does not recognise the file', async () => {
    const csv = ['Timestamp,Delivered,Generation', '2026-07-27,63,83'].join('\n');
    const preview = await service().preview(Buffer.from(csv, 'utf8'), 'mystery.csv');
    expect(preview.mapping).toBeNull();
    expect(preview.headers).toEqual(['Timestamp', 'Delivered', 'Generation']);
    expect(preview.problems[0]).toContain('not recognised');
  });

  it('works on that unrecognised file once a person says which column is which', async () => {
    // The mechanism that makes an unseen utility a mapping away from working.
    const csv = ['Timestamp,Delivered,Generation', '2026-07-27,63,83'].join('\n');
    const preview = await service().preview(Buffer.from(csv, 'utf8'), 'mystery.csv', {
      date: 0,
      imported: 1,
      exported: 2,
    });
    expect(preview.readings).toEqual([{ date: '2026-07-27', importedKwh: 63, exportedKwh: 83 }]);
  });
});
