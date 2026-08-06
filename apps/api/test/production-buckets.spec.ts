import { describe, expect, it } from 'vitest';
import { bucketProduction, describeBuckets } from '../src/readings/production-buckets';

/*
  This array began reporting on 23 July, so July holds nine days and August holds three.
  Totalled into plain bars that reads as "production collapsed in August" — the first thing
  anyone would take from the shapes, and false. Most of these tests are about the machinery
  that stops the chart saying it.
*/

const JULY_TO_AUGUST = [
  { date: '2026-07-23', energyWh: 39_985 },
  { date: '2026-07-24', energyWh: 62_000 },
  { date: '2026-07-31', energyWh: 46_000 },
  { date: '2026-08-01', energyWh: 60_000 },
  { date: '2026-08-02', energyWh: 72_000 },
  { date: '2026-08-03', energyWh: 56_635 },
];

describe('bucketProduction', () => {
  it('totals by month', () => {
    const [july, august] = bucketProduction(JULY_TO_AUGUST, 'month', '2026-08-03');
    expect(july.key).toBe('2026-07');
    expect(july.energyWh).toBe(147_985);
    expect(august.energyWh).toBe(188_635);
  });

  it('marks a month we only partly recorded as incomplete', () => {
    // Three of July's 31 days. The total is real; the comparison is not.
    const [july] = bucketProduction(JULY_TO_AUGUST, 'month', '2026-08-03');
    expect(july.complete).toBe(false);
    expect(july.daysWithData).toBe(3);
    expect(july.daysInPeriod).toBe(31);
  });

  it('never calls the period in progress complete', () => {
    /*
      Even with every elapsed day recorded. August is three days old; today is still
      accumulating. A bar that is still growing must not be set beside finished ones as
      though the comparison were fair.
    */
    const [, august] = bucketProduction(JULY_TO_AUGUST, 'month', '2026-08-03');
    expect(august.complete).toBe(false);
  });

  it('calls a fully recorded past month complete', () => {
    const full = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      energyWh: 50_000,
    }));
    const [june] = bucketProduction(full, 'month', '2026-08-03');
    expect(june.complete).toBe(true);
    expect(june.daysInPeriod).toBe(30);
  });

  it('knows February', () => {
    // 2026 is not a leap year; 2024 was. A hardcoded 28 or 30 would pass most tests.
    const feb = (year: number) =>
      bucketProduction([{ date: `${year}-02-05`, energyWh: 1 }], 'month', '2026-08-03')[0];
    expect(feb(2026).daysInPeriod).toBe(28);
    expect(feb(2024).daysInPeriod).toBe(29);
  });

  it('treats today as incomplete at day granularity too', () => {
    const days = bucketProduction(JULY_TO_AUGUST, 'day', '2026-08-03');
    expect(days.at(-1)?.key).toBe('2026-08-03');
    expect(days.at(-1)?.complete).toBe(false);
    expect(days.at(-2)?.complete).toBe(true);
  });

  it('totals by year, and the current year is never complete', () => {
    const [year] = bucketProduction(JULY_TO_AUGUST, 'year', '2026-08-03');
    expect(year.key).toBe('2026');
    expect(year.energyWh).toBe(336_620);
    expect(year.daysInPeriod).toBe(365);
    expect(year.complete).toBe(false);
  });

  it('labels a month so it cannot be read as a day', () => {
    /*
      "Jul 26" for July 2026 is the same string the day grouping produces for 26 July —
      identical text meaning different things, on a chart built for comparing periods.
    */
    const [july] = bucketProduction(JULY_TO_AUGUST, 'month', '2026-08-03');
    expect(july.label).toBe('Jul 2026');

    const dayLabels = bucketProduction(JULY_TO_AUGUST, 'day', '2026-08-03').map((b) => b.label);
    const monthLabels = bucketProduction(JULY_TO_AUGUST, 'month', '2026-08-03').map((b) => b.label);
    expect(dayLabels.filter((l) => monthLabels.includes(l))).toEqual([]);
  });

  it('sorts oldest first', () => {
    const shuffled = [...JULY_TO_AUGUST].reverse();
    const keys = bucketProduction(shuffled, 'month', '2026-08-03').map((b) => b.key);
    expect(keys).toEqual(['2026-07', '2026-08']);
  });

  it('counts a duplicated date once', () => {
    // Two rows for one day must not make a month look better observed than it is.
    const dupes = [
      { date: '2026-07-23', energyWh: 10_000 },
      { date: '2026-07-23', energyWh: 10_000 },
    ];
    const [july] = bucketProduction(dupes, 'month', '2026-08-03');
    expect(july.daysWithData).toBe(1);
    expect(july.energyWh).toBe(20_000);
  });

  it('drops a malformed date instead of bucketing it as NaN', () => {
    const buckets = bucketProduction(
      [{ date: 'not-a-date', energyWh: 5 }, { date: '2026-07-23', energyWh: 10 }],
      'month',
      '2026-08-03',
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe('2026-07');
  });

  it('does not call a future-dated bucket complete', () => {
    // A clock skew on the collector should not produce a "finished" month ahead of today.
    const [, ahead] = bucketProduction(
      [{ date: '2026-08-01', energyWh: 1 }, { date: '2026-09-01', energyWh: 1 }],
      'month',
      '2026-08-03',
    );
    expect(ahead.complete).toBe(false);
  });

  it('returns nothing for no data, rather than a zero bar', () => {
    expect(bucketProduction([], 'month', '2026-08-03')).toEqual([]);
  });
});

describe('describeBuckets', () => {
  it('says plainly when nothing can be compared yet', () => {
    const months = bucketProduction(JULY_TO_AUGUST, 'month', '2026-08-03');
    expect(describeBuckets(months, 'month')).toMatch(/No complete months yet/);
  });

  it('says so when there is a single period in progress', () => {
    const years = bucketProduction(JULY_TO_AUGUST, 'year', '2026-08-03');
    expect(describeBuckets(years, 'year')).toMatch(/nothing to compare it against yet/);
  });

  it('counts the complete periods once there are some', () => {
    const days = bucketProduction(JULY_TO_AUGUST, 'day', '2026-08-03');
    expect(describeBuckets(days, 'day')).toMatch(/5 complete days; 1 part-period/);
  });

  it('handles an empty set', () => {
    expect(describeBuckets([], 'day')).toBe('Nothing recorded yet.');
  });
});
