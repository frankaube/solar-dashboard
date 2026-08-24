import { describe, expect, it } from 'vitest';
import { bucketByHour, hourStartOf, reconcile } from '../src/readings/rollup';

/*
  Folding the five-minute record into hours, so that one day it can stop growing forever.

  Nothing deletes anything yet, and these tests are the reason: they are enough to trust a
  summary written alongside the original, and nowhere near enough to trust throwing the
  original away. Two ways the fold could quietly lose energy are pinned here — taking it as an
  integral of power rather than as the counter's rise, and reading a counter reset as
  production — and a purge will additionally have to be argued from months of the two copies
  agreeing on real data.
*/

const ZONE = 'America/Halifax';
const at = (iso: string): Date => new Date(iso);

/** Five-minute samples across one hour, with a counter rising by `perStep`. */
const run = (startIso: string, count: number, powerW: number, from: number, perStep: number) =>
  Array.from({ length: count }, (_, i) => ({
    takenAt: new Date(Date.parse(startIso) + i * 5 * 60_000),
    powerW,
    counter: from + i * perStep,
  }));

describe('hourStartOf', () => {
  it('floors to the hour', () => {
    expect(hourStartOf(at('2026-08-14T13:47:31Z')).toISOString()).toBe('2026-08-14T13:00:00.000Z');
  });
});

describe('bucketByHour', () => {
  it('takes energy from the counter, not from the power curve', () => {
    /*
      The decision the rest of the app already made. The counter lives on the gateway and
      survives anything this app failed to see; integrating samples under-reports every gap.
      Here the power is a flat 6 kW for an hour but the counter only rose 4,000 Wh, because
      the array was down for part of it — and 4,000 is the true answer.
    */
    const samples = run('2026-08-14T13:00:00Z', 12, 6000, 100_000, 0).map((s, i) => ({
      ...s,
      counter: 100_000 + (i === 11 ? 4000 : 0),
    }));
    const [hour] = bucketByHour(samples, ZONE, 100_000);
    expect(hour.energyWh).toBe(4000);
    expect(hour.maxPowerW).toBe(6000);
  });

  it('carries the counter across the hour boundary', () => {
    /*
      Without the carry, each hour's energy would start from its own first sample and lose
      whatever was made between the last reading of one hour and the first of the next. That
      is five minutes an hour, about 2% of every day, gone quietly.
    */
    const first = run('2026-08-14T13:00:00Z', 12, 5000, 0, 400);
    const second = run('2026-08-14T14:00:00Z', 12, 5000, 5200, 400);
    const hours = bucketByHour([...first, ...second], ZONE, 0);
    expect(hours).toHaveLength(2);
    // Second hour starts at 5,200 having ended the first at 4,400: the 800 in between counts.
    expect(hours[1].energyWh).toBe(second[second.length - 1].counter - first[first.length - 1].counter);
  });

  it('treats a counter going backwards as a reset worth nothing, not as production', () => {
    // Midnight, or a replaced microinverter. Read as a rise it would hand a panel a lifetime
    // of energy in a single hour.
    const samples = run('2026-08-14T13:00:00Z', 4, 3000, 0, 0);
    const [hour] = bucketByHour(samples, ZONE, 900_000);
    expect(hour.energyWh).toBe(0);
  });

  it('records how many readings an hour rests on', () => {
    // Twelve and three are different facts, and the app does not show a figure without being
    // able to say which it is.
    const [hour] = bucketByHour(run('2026-08-14T13:00:00Z', 3, 4000, 0, 300), ZONE, 0);
    expect(hour.samples).toBe(3);
  });

  it('keeps the provenance the raw rows carried', () => {
    /*
      `source` on the raw row is the audit trail for a gap filled from a vendor export. It
      would die with the rows it describes unless the hour counts it.
    */
    const samples = run('2026-08-14T13:00:00Z', 4, 4000, 0, 300).map((s, i) => ({
      ...s,
      imported: i < 2,
    }));
    const [hour] = bucketByHour(samples, ZONE, 0);
    expect(hour.imported).toBe(2);
    expect(hour.samples).toBe(4);
  });

  it('stamps the site-local day, which is what every rollup groups by', () => {
    // 01:30Z on the 15th is the evening of the 14th in Atlantic time.
    const [hour] = bucketByHour(run('2026-08-15T01:30:00Z', 2, 100, 0, 10), ZONE, 0);
    expect(hour.localDate).toBe('2026-08-14');
  });

  it('is order-independent, since rows arrive however the query returned them', () => {
    const samples = run('2026-08-14T13:00:00Z', 6, 5000, 0, 500);
    const forward = bucketByHour(samples, ZONE, 0);
    const shuffled = bucketByHour([...samples].reverse(), ZONE, 0);
    expect(shuffled).toEqual(forward);
  });
});



describe('reconcile', () => {
  /*
    The check that would have to be clean for a long time before deleting anything is even
    discussed. It is reported, never acted on.
  */
  it('agrees when the hours add up to what the gateway reported for the day', () => {
    expect(reconcile(42_290, 42_290).agrees).toBe(true);
  });

  it('tolerates a rounding watt, since each hour is rounded to whole Wh', () => {
    expect(reconcile(42_290, 42_291).agrees).toBe(true);
  });

  it('reports a real gap, and says which way it went', () => {
    const off = reconcile(42_290, 41_000);
    expect(off.agrees).toBe(false);
    expect(off.differenceWh).toBe(-1290);
  });
});

describe('a counter that winds down', () => {
  /*
    The bug this found on real data. The gateway's daily figure falls back as the array
    settles in the evening, and the peak often happens mid-hour. Measuring each hour from the
    previous hour's LAST sample loses whatever was reached and then given back: 4 to 160 Wh a
    day here, always short, on thirteen days out of twenty-two. Every other rollup in this app
    takes a day as MAX(dailyEnergy) for the same reason.
  */
  it('counts what the counter reached, not where it ended', () => {
    const samples = [
      { takenAt: new Date('2026-08-14T13:00:00Z'), powerW: 900, counter: 1000 },
      { takenAt: new Date('2026-08-14T13:30:00Z'), powerW: 500, counter: 1160 }, // the peak
      { takenAt: new Date('2026-08-14T13:55:00Z'), powerW: 0, counter: 1120 },   // wound back
    ];
    const [hour] = bucketByHour(samples, ZONE, 0);
    expect(hour.energyWh).toBe(1160);
    // The raw last value is still recorded, because the lifetime query reads that column.
    expect(hour.lastCounter).toBe(1120);
  });

  it('does not re-count a peak the next hour climbs back to', () => {
    const first = [{ takenAt: new Date('2026-08-14T13:30:00Z'), powerW: 500, counter: 1160 }];
    const second = [
      { takenAt: new Date('2026-08-14T14:10:00Z'), powerW: 100, counter: 1100 },
      { takenAt: new Date('2026-08-14T14:50:00Z'), powerW: 300, counter: 1200 },
    ];
    const hours = bucketByHour([...first, ...second], ZONE, 0);
    expect(hours[0].energyWh).toBe(1160);
    expect(hours[1].energyWh).toBe(40); // only the 40 above the previous high-water mark
  });

  it('sums to the day maximum, which is what the rest of the app calls a day', () => {
    const day = [1000, 5000, 9000, 12000, 11800].map((counter, i) => ({
      takenAt: new Date(Date.parse('2026-08-14T12:00:00Z') + i * 3_600_000),
      powerW: 1000,
      counter,
    }));
    const total = bucketByHour(day, ZONE, 0).reduce((sum, h) => sum + h.energyWh, 0);
    expect(total).toBe(Math.max(...day.map((d) => d.counter)));
  });
});
