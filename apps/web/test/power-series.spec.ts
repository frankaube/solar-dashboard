import { describe, expect, it } from 'vitest';
import { powerSeries } from '../src/charts/preset';

/*
  The three lines on expected-vs-actual, and when there are only two.

  Yesterday is context rather than a claim about today, and the cases that matter are the
  ones where it should not appear at all: an install younger than a day, or a day the
  collector missed entirely. Drawn flat at zero, an absent yesterday looks like an outage —
  a worse answer than saying nothing.
*/

const today: Array<[string, number | null]> = [
  ['2026-08-06T14:00:00Z', 10_000],
  ['2026-08-06T14:05:00Z', 10_500],
];
const expected: Array<[string, number | null]> = [
  ['2026-08-06T14:00:00Z', 9_000],
  ['2026-08-06T14:05:00Z', 9_400],
];

const names = (series: ReturnType<typeof powerSeries>): Array<string | undefined> =>
  series.map((s) => (s as { name?: string }).name);

describe('powerSeries', () => {
  it('is two lines when no yesterday is supplied', () => {
    expect(names(powerSeries(today, expected))).toEqual(['Expected', 'Actual']);
  });

  it('adds yesterday when there is one', () => {
    const series = powerSeries(today, expected, [
      ['2026-08-06T14:00:00Z', 8_800],
      ['2026-08-06T14:05:00Z', 9_100],
    ]);
    expect(names(series)).toEqual(['Yesterday', 'Expected', 'Actual']);
  });

  it('omits it entirely when every value is null', () => {
    /*
      A first day, or a day the collector missed. An all-null series is not an empty chart
      line — it is a flat run at the axis floor in some renderers, which reads as the array
      having produced nothing.
    */
    const series = powerSeries(today, expected, [
      ['2026-08-06T14:00:00Z', null],
      ['2026-08-06T14:05:00Z', null],
    ]);
    expect(names(series)).toEqual(['Expected', 'Actual']);
  });

  it('keeps it when only some points are missing', () => {
    // A gap in yesterday's record is a hole in the line, not a reason to drop the whole
    // comparison — the rest of the day is still real.
    const series = powerSeries(today, expected, [
      ['2026-08-06T14:00:00Z', null],
      ['2026-08-06T14:05:00Z', 9_100],
    ]);
    expect(names(series)).toEqual(['Yesterday', 'Expected', 'Actual']);
  });

  it('does not draw yesterday at all', () => {
    /*
      It was a visible line for one afternoon and it was a mistake: this chart rolls over
      twenty-four hours, so its left half is already yesterday, and a yesterday line there
      plots the day before — which cannot match the curve beside it and reads as corruption.
      The series stays only so the tooltip has a value to show.
    */
    const series = powerSeries(today, expected, [['2026-08-06T14:00:00Z', 8_800]]);
    const stroke = (series[0] as { lineStyle?: { opacity?: number } }).lineStyle;
    expect(stroke?.opacity).toBe(0);
  });

  it('formats yesterday in kW like the rest', () => {
    const series = powerSeries(today, expected, [['2026-08-06T14:00:00Z', 8_800]]);
    const formatter = (series[0] as { tooltip?: { valueFormatter?: (v: unknown) => string } }).tooltip
      ?.valueFormatter;
    expect(formatter?.(8_800)).toMatch(/kW/);
  });
});

describe('finding a series by name', () => {
  it('is why the daylight band stopped using an index', () => {
    /*
      The Overview chart hangs its sunrise-to-sunset band off "Actual" by reaching for
      series[1]. That was correct while there were exactly two lines and quietly wrong the
      moment a third appeared in front of them — the band would have attached to Expected on
      any day a yesterday existed, which is most of them.
    */
    const withYesterday = powerSeries(today, expected, [['2026-08-06T14:00:00Z', 8_800]]);
    const without = powerSeries(today, expected);

    const nameAt = (s: ReturnType<typeof powerSeries>, i: number) => (s[i] as { name?: string }).name;
    expect(nameAt(without, 1)).toBe('Actual');
    expect(nameAt(withYesterday, 1)).toBe('Expected'); // the shift that broke it

    const byName = (s: ReturnType<typeof powerSeries>) =>
      s.find((x) => (x as { name?: string }).name === 'Actual');
    expect(byName(withYesterday)).toBeDefined();
    expect(byName(without)).toBeDefined();
  });
});
