import { describe, expect, it } from 'vitest';
import {
  dayEnergyWh,
  isLocalDate,
  nextLocalDate,
  previousLocalDate,
  shiftToDay,
} from '../src/readings/day-history';

/*
  A single calendar day, on an axis that means the same thing every time it is opened.

  The rolling twenty-four-hour chart is the wrong shape for "what did the roof do on the
  fourth" — half of it is the day before, which is exactly what made a yesterday overlay
  incoherent when it was tried there. Pinned to midnight, the previous day lands on top of
  the current one and the comparison is finally honest.
*/

describe('isLocalDate', () => {
  it('accepts a real date', () => {
    expect(isLocalDate('2026-08-06')).toBe(true);
  });

  it('rejects a plausible-looking string that is not a date', () => {
    // Comes off a query string, so it is whatever somebody typed.
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('06-08-2026')).toBe(false);
    expect(isLocalDate('yesterday')).toBe(false);
    expect(isLocalDate('')).toBe(false);
  });
});

describe('walking the calendar', () => {
  it('steps back and forward a day', () => {
    expect(previousLocalDate('2026-08-06')).toBe('2026-08-05');
    expect(nextLocalDate('2026-08-06')).toBe('2026-08-07');
  });

  it('crosses a month end', () => {
    expect(previousLocalDate('2026-08-01')).toBe('2026-07-31');
    expect(nextLocalDate('2026-07-31')).toBe('2026-08-01');
  });

  it('crosses a year end', () => {
    expect(previousLocalDate('2026-01-01')).toBe('2025-12-31');
    expect(nextLocalDate('2025-12-31')).toBe('2026-01-01');
  });

  it('knows February in a leap year', () => {
    expect(nextLocalDate('2028-02-28')).toBe('2028-02-29');
    expect(previousLocalDate('2028-03-01')).toBe('2028-02-29');
  });
});

describe('dayEnergyWh', () => {
  it('takes the gateway counter at its highest, not a sum of the curve', () => {
    /*
      The counter is cumulative and lives on the gateway, so it survives a gap in collection.
      Integrating the five-minute samples would under-report every day this app was not
      watching — including the three and a half hours it missed on 6 August.
    */
    expect(dayEnergyWh([{ dailyEnergy: 1000 }, { dailyEnergy: 40_550 }, { dailyEnergy: 39_000 }])).toBe(
      40_550,
    );
  });

  it('is null for a day with no readings at all', () => {
    // Distinct from zero, which is a real answer for a day the array made nothing.
    expect(dayEnergyWh([])).toBeNull();
  });

  it('is zero, not null, for a day that produced nothing', () => {
    expect(dayEnergyWh([{ dailyEnergy: 0 }])).toBe(0);
  });
});

describe('shiftToDay', () => {
  const zone = 'America/Halifax';

  it('moves a curve onto another day at the same wall clock', () => {
    // So the comparison sits on the axis being viewed rather than beside it.
    const shifted = shiftToDay(
      [{ t: '2026-08-05T13:35:00Z', powerW: 9000 }],
      '2026-08-06',
      zone,
    );
    expect(shifted[0].t).toBe('2026-08-06T10:35:00');
    expect(shifted[0].powerW).toBe(9000);
  });

  it('lines up by clock across a daylight-saving change', () => {
    /*
      A flat 24-hour shift would put the comparison an hour out on the two days a year the
      offset changes — and an hour is a different sun angle, which is the whole point of
      laying one day over another.
    */
    const beforeChange = shiftToDay(
      [{ t: '2026-03-07T16:00:00Z', powerW: 5000 }], // 12:00 AST
      '2026-03-08',
      zone,
    );
    expect(beforeChange[0].t).toBe('2026-03-08T12:00:00');
  });

  it('keeps an empty day empty', () => {
    expect(shiftToDay([], '2026-08-06', zone)).toEqual([]);
  });
});
