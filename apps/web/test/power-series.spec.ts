import { describe, expect, it } from 'vitest';
import { powerSeries } from '../src/charts/preset';

/*
  The three lines on expected-vs-actual, and when there are only two. Drawn flat at zero, an
  absent yesterday looks like an outage, so it is omitted instead.
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
    // Some renderers draw an all-null series as a flat run at the axis floor.
    const series = powerSeries(today, expected, [
      ['2026-08-06T14:00:00Z', null],
      ['2026-08-06T14:05:00Z', null],
    ]);
    expect(names(series)).toEqual(['Expected', 'Actual']);
  });

  it('keeps it when only some points are missing', () => {
    const series = powerSeries(today, expected, [
      ['2026-08-06T14:00:00Z', null],
      ['2026-08-06T14:05:00Z', 9_100],
    ]);
    expect(names(series)).toEqual(['Yesterday', 'Expected', 'Actual']);
  });

  it('does not draw yesterday at all', () => {
    /*
      The chart rolls over twenty-four hours, so its left half is already yesterday and a
      yesterday line there plots the day before. The series stays only for the tooltip.
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
      The Overview chart hangs its sunrise-to-sunset band off "Actual". Index 1 is Actual
      with two lines and Expected once yesterday is prepended, so it must match by name.
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
