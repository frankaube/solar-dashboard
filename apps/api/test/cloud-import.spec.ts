import { describe, expect, it } from 'vitest';
import { NEAR_MS, instantFor, parseExport, planImport } from '../src/readings/cloud-import';

/*
  Repairing a hole in the power history from the vendor's own export.

  The tests that matter are the refusals. This writes into the table that holds every
  measurement this app has ever taken, from a file somebody pasted in, and the failure to
  guard against is not a crash — it is an import that quietly overwrites a real reading, or
  inflates a day's total, and is never noticed because both look like data afterwards.
*/

const ZONE = 'America/Halifax';

/** A real reading already in the table. */
const recorded = (iso: string, dailyEnergy = 0) => ({
  takenAt: new Date(iso),
  localDate: '2026-08-06',
  dailyEnergy,
});

describe('instantFor', () => {
  it('resolves a wall clock against the zone rather than a fixed offset', () => {
    // 05:35 Atlantic Daylight is 08:35 UTC. A hardcoded offset would be wrong for half the
    // year, and silently wrong on the two days it changes.
    expect(instantFor('2026-08-06', '05:35', ZONE).toISOString()).toBe('2026-08-06T08:35:00.000Z');
  });

  it('gets the winter offset right too', () => {
    expect(instantFor('2026-01-15', '05:35', ZONE).toISOString()).toBe('2026-01-15T09:35:00.000Z');
  });
});

describe('parseExport', () => {
  it('reads the shape S-Miles produces, address column and all', () => {
    /*
      The first column is the plant name, which on a home install is the owner's street
      address. Taking the last two cells rather than the first two means it is never read,
      never stored and never echoed back.
    */
    const text = [
      '28 Example Street NB\t2026-08-06 05:35\t0',
      '28 Example Street NB\t2026-08-06 05:40\t142',
    ].join('\n');
    const { points, dates } = parseExport(text, { zone: ZONE });
    expect(points).toHaveLength(2);
    expect(points[1].watts).toBe(142);
    expect(dates).toEqual(['2026-08-06']);
    expect(points[0].at.toISOString()).toBe('2026-08-06T08:35:00.000Z');
  });

  it('accepts a bare time when told which day it belongs to', () => {
    const { points } = parseExport('05:35\t0\n05:40\t142', { zone: ZONE, fallbackDate: '2026-08-06' });
    expect(points).toHaveLength(2);
    expect(points[0].localDate).toBe('2026-08-06');
  });

  it('refuses a bare time with no day rather than guessing one', () => {
    // Assuming "today" would file last week's export under this morning, which is worse than
    // refusing it: the rows would look real and sit in the wrong place forever.
    expect(parseExport('05:35\t0', { zone: ZONE }).points).toEqual([]);
  });

  it('handles an export that spans midnight', () => {
    const text = ['2026-08-05 23:55\t10', '2026-08-06 00:00\t8'].join('\n');
    expect(parseExport(text, { zone: ZONE }).dates).toEqual(['2026-08-05', '2026-08-06']);
  });

  it('sorts, so a file in any order still integrates correctly', () => {
    const text = ['2026-08-06 06:00\t100', '2026-08-06 05:35\t0'].join('\n');
    const { points } = parseExport(text, { zone: ZONE });
    expect(points[0].watts).toBe(0);
  });

  it('ignores a header and counts an unreadable data row', () => {
    const text = ['Plant\tTime\tPower', '2026-08-06 05:35\t0'].join('\n');
    const result = parseExport(text, { zone: ZONE });
    expect(result.points).toHaveLength(1);
    expect(result.rejected).toBe(0);
  });
});

describe('planImport', () => {
  const points = parseExport(
    ['2026-08-06 05:35\t0', '2026-08-06 05:40\t120', '2026-08-06 05:45\t240'].join('\n'),
    { zone: ZONE },
  ).points;

  it('writes nothing where a real reading already sits', () => {
    /*
      The refusal that matters most. A polled reading is this system's own measurement; an
      imported one is the vendor's. Overwriting the first with the second would be
      undetectable afterwards and would quietly replace evidence with a copy of it.
    */
    const plan = planImport(points, [recorded('2026-08-06T08:40:00Z')]);
    expect(plan.insert).toHaveLength(2);
    expect(plan.covered).toBe(1);
    expect(plan.insert.some((r) => r.at.toISOString() === '2026-08-06T08:40:00.000Z')).toBe(false);
  });

  it('treats "close enough" as covered, because polls do not land on the minute', () => {
    // The collector polls on its own clock: 08:40:57, not 08:40:00. Requiring an exact match
    // would import a duplicate beside every real reading.
    const plan = planImport(points, [recorded('2026-08-06T08:40:57Z')]);
    expect(plan.covered).toBe(1);
    expect(NEAR_MS).toBeGreaterThan(57_000);
  });

  it('is a no-op when run twice', () => {
    const first = planImport(points, []);
    const asRecorded = first.insert.map((row) => ({
      takenAt: row.at,
      localDate: row.localDate,
      dailyEnergy: row.dailyEnergy,
    }));
    expect(planImport(points, asRecorded).insert).toEqual([]);
  });

  it('integrates energy from the power, never reading it from the file', () => {
    /*
      This is what makes an import unable to inflate a day. The gateway's counter is
      cumulative and was never damaged; every value written here is built from the power
      curve alone, so it lands underneath.
    */
    const plan = planImport(points, []);
    expect(plan.insert[0].dailyEnergy).toBe(0);
    // 0→120 W then 120→240 W, five minutes each: 5 Wh then 15 Wh.
    expect(plan.insert[1].dailyEnergy).toBe(5);
    expect(plan.insert[2].dailyEnergy).toBe(20);
  });

  it('reports imported energy against what is already recorded, per day', () => {
    // So somebody can see, before committing, that the import stays under the real counter.
    const plan = planImport(points, [recorded('2026-08-06T12:00:00Z', 6478)]);
    expect(plan.perDay[0].recordedPeakWh).toBe(6478);
    expect(plan.perDay[0].importedPeakWh).toBeLessThan(6478);
  });

  it('restarts energy at each local date', () => {
    // The counter it shadows resets at midnight; integrating through would hand the second
    // day a head start it never had.
    const spanning = parseExport(
      ['2026-08-05 23:55\t1000', '2026-08-06 00:00\t1000', '2026-08-06 00:05\t1000'].join('\n'),
      { zone: ZONE },
    ).points;
    const plan = planImport(spanning, []);
    const secondDay = plan.insert.filter((r) => r.localDate === '2026-08-06');
    expect(secondDay[0].dailyEnergy).toBe(0);
  });
});
