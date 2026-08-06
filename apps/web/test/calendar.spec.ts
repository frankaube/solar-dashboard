import { describe, expect, it } from 'vitest';
import { calendarRange, summarise } from '../src/charts/calendar';

/*
  The grid encodes magnitude as colour and nothing else — you cannot read a value off a
  green square. These are the figures printed beside it in words, which makes them the only
  version of this chart that carries numbers. They have to be right.
*/

const day = (date: string, kwh: number) => ({ date, energyWh: kwh * 1000 });

describe('summarise', () => {
  it('reports the best day, the middle one, and the total', () => {
    const stats = summarise([
      day('2026-07-01', 10),
      day('2026-07-02', 50),
      day('2026-07-03', 30),
    ]);
    expect(stats.bestDate).toBe('2026-07-02');
    expect(stats.bestKwh).toBe(50);
    expect(stats.medianKwh).toBe(30);
    expect(stats.totalKwh).toBe(90);
    expect(stats.producingDays).toBe(3);
  });

  it('takes the median rather than the mean', () => {
    /*
      The whole reason this figure exists. A fortnight of outage drags a mean down to a
      number no actual day resembles — "your typical day is 12 kWh" on an array that makes
      40 whenever it is working. The median steps over the hole.
    */
    const days = [
      ...Array.from({ length: 10 }, (_, i) => day(`2026-07-${String(i + 1).padStart(2, '0')}`, 40)),
      ...Array.from({ length: 9 }, (_, i) => day(`2026-07-${String(i + 11).padStart(2, '0')}`, 1)),
    ];
    const stats = summarise(days);
    expect(stats.medianKwh).toBe(40);
    // The mean would be about 21.5 — a value not one of these nineteen days came near.
    expect(stats.totalKwh / stats.producingDays).toBeLessThan(25);
  });

  it('averages the two middle days when there is an even number', () => {
    const stats = summarise([day('2026-07-01', 10), day('2026-07-02', 20)]);
    expect(stats.medianKwh).toBe(15);
  });

  it('leaves days of nothing out of the count instead of averaging them in', () => {
    /*
      A day with no reading is not a day the array made nothing — it is a day nobody was
      collecting, and counting it as zero drags every figure here toward a gap in the
      record rather than toward anything about the roof.
    */
    const stats = summarise([day('2026-07-01', 40), day('2026-07-02', 0), day('2026-07-03', 40)]);
    expect(stats.producingDays).toBe(2);
    expect(stats.medianKwh).toBe(40);
    expect(stats.totalKwh).toBe(80);
  });

  it('says nothing rather than dividing by nothing', () => {
    const stats = summarise([]);
    expect(stats.bestDate).toBeNull();
    expect(stats.medianKwh).toBe(0);
    expect(stats.producingDays).toBe(0);
  });
});

describe('calendarRange', () => {
  it('spans the data, not the year', () => {
    /*
      An install three weeks old would otherwise render eleven months of empty cells and
      read as an array that produced nothing all year — the worst possible first look.
    */
    expect(calendarRange([day('2026-07-14', 5), day('2026-07-01', 9)])).toEqual([
      '2026-07-01',
      '2026-07-14',
    ]);
  });

  it('has no range at all with no data', () => {
    expect(calendarRange([])).toBeNull();
  });
});
