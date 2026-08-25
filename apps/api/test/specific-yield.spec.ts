import { describe, expect, it } from 'vitest';
import { specificYield, summariseYield } from '../src/readings/specific-yield';

/*
  Dividing by capacity buys comparability; refusing when capacity was guessed keeps a
  measurement divided by a guess off a page where it would print like a measurement.
*/

const days = [
  { date: '2026-07-30', energyWh: 18_600 },
  { date: '2026-07-31', energyWh: 45_800 },
  { date: '2026-08-01', energyWh: 49_100 },
  { date: '2026-08-02', energyWh: 83_800 },
  { date: '2026-08-03', energyWh: 109_900 },
  { date: '2026-08-04', energyWh: 8_900 }, // today, still in progress
];

describe('specificYield', () => {
  it('divides watt-hours by installed kilowatts', () => {
    expect(specificYield(109_900, 23)).toBeCloseTo(4.778, 3);
  });

  it('refuses a divisor that cannot be one', () => {
    for (const rated of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(specificYield(50_000, rated)).toBeNull();
    }
  });

  it('keeps a real zero apart from a missing reading', () => {
    // A day with no sun produced nothing; a day with no data produced we-do-not-know.
    expect(specificYield(0, 23)).toBe(0);
    expect(specificYield(null, 23)).toBeNull();
    expect(specificYield(undefined, 23)).toBeNull();
  });
});

describe('summariseYield', () => {
  it('reports today, the rolling mean and the best day', () => {
    const summary = summariseYield(days, 23, true, '2026-08-04');
    expect(summary?.todayKwhPerKwp).toBe(0.39);
    expect(summary?.bestDayKwhPerKwp).toBe(4.78);
    expect(summary?.bestDayDate).toBe('2026-08-03');
    expect(summary?.rollingDays).toBe(5);
  });

  it('refuses entirely when the array size was estimated', () => {
    // The estimate is panel count times an assumed 500 W.
    expect(summariseYield(days, 21, false, '2026-08-04')).toBeNull();
  });

  it('excludes today from the average and from the best day', () => {
    const summary = summariseYield(days, 23, true, '2026-08-04');
    // A day in progress drags the mean down every morning and cannot win "best day".
    const wholeDayMean = (18_600 + 45_800 + 49_100 + 83_800 + 109_900) / 5 / 1000 / 23;
    expect(summary?.rollingKwhPerKwp).toBeCloseTo(wholeDayMean, 2);
    expect(summary?.bestDayDate).not.toBe('2026-08-04');
  });

  it('averages only the days it has, rather than dividing by thirty', () => {
    // Two weeks in, the mean is over two weeks — not two weeks of sun spread over a month.
    const summary = summariseYield(days.slice(0, 2), 23, true, '2026-08-04');
    expect(summary?.rollingDays).toBe(2);
    expect(summary?.rollingKwhPerKwp).toBeCloseTo((18_600 + 45_800) / 2 / 1000 / 23, 2);
  });

  it('has no rolling figure on the very first day', () => {
    const summary = summariseYield([{ date: '2026-08-04', energyWh: 8_900 }], 23, true, '2026-08-04');
    expect(summary?.rollingKwhPerKwp).toBeNull();
    expect(summary?.bestDayKwhPerKwp).toBeNull();
    expect(summary?.todayKwhPerKwp).toBe(0.39);
  });
});
