import { describe, expect, it } from 'vitest';
import { localHourOf } from '../src/readings/analytics.service';

/*
  Which hour a panel's losses are attributed to.

  It decides whether the app calls a deficit "shading" — losses concentrated in a few hours —
  or "soiling", which is an all-day loss. It was `getUTCHours() - 3`: Atlantic daylight time,
  written as a constant. An hour out every winter, and wrong outright for an array anywhere
  else, while quietly changing the diagnosis the owner is shown.

  Every case below names its zone. The first version of this file did not, and asserted
  Atlantic hours against whatever zone the machine happened to be in — green on the developer's
  laptop, three hours out in CI, and testing the host rather than the function. `TZ=UTC` before
  pushing is in the development guide for exactly this.
*/

const ATLANTIC = 'America/Halifax';

describe('localHourOf', () => {
  it('reads an instant in the site timezone rather than in UTC', () => {
    // 14:07 UTC is 11:07 in Atlantic daylight time.
    expect(localHourOf(Date.parse('2026-08-06T14:07:00Z'), ATLANTIC)).toBe(11);
    expect(localHourOf(Date.parse('2026-08-06T14:07:00Z'), 'UTC')).toBe(14);
  });

  it('follows the offset across the winter change instead of assuming one', () => {
    /*
      The bug in one assertion. In January the zone is UTC-4, not UTC-3, so a hardcoded -3
      attributes every loss to the hour after the one it happened in.
    */
    expect(localHourOf(Date.parse('2026-01-15T15:00:00Z'), ATLANTIC)).toBe(11);
    expect(localHourOf(Date.parse('2026-07-15T14:00:00Z'), ATLANTIC)).toBe(11);
  });

  it('keeps midnight at zero rather than twenty-four', () => {
    // Some locales format midnight as "24", which would index past the end of a 24-slot array.
    expect(localHourOf(Date.parse('2026-08-06T03:00:00Z'), ATLANTIC)).toBe(0);
  });

  it('gives the same answer twice, because it is memoised by the hour', () => {
    const at = Date.parse('2026-08-06T14:07:00Z');
    expect(localHourOf(at, ATLANTIC)).toBe(localHourOf(at + 60_000, ATLANTIC));
  });

  it('keeps zones apart in the cache when they are asked for in turn', () => {
    /*
      The risk the memo introduces. The cache was keyed on the hour bucket alone, so once a
      zone is a parameter, handing back one zone's answer for another would be invisible in
      the output and wrong for every reading it touched.
    */
    const at = Date.parse('2026-08-06T14:07:00Z');
    expect(localHourOf(at, ATLANTIC)).toBe(11);
    expect(localHourOf(at, 'Pacific/Auckland')).toBe(2);
    expect(localHourOf(at, ATLANTIC)).toBe(11);
  });
});
