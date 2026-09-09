import { describe, expect, it } from 'vitest';
import { localHourOf } from '../src/readings/analytics.service';

/*
  Which hour a panel's losses are attributed to; it decides whether a deficit reads as
  "shading" (a few hours) or "soiling" (all day).

  Every case names its zone explicitly. CI runs UTC while the site is Atlantic, so a suite
  that inherited the host zone would pass on a laptop and fail in CI.
*/

const ATLANTIC = 'America/Halifax';

describe('localHourOf', () => {
  it('reads an instant in the site timezone rather than in UTC', () => {
    // 14:07 UTC is 11:07 in Atlantic daylight time.
    expect(localHourOf(Date.parse('2026-08-06T14:07:00Z'), ATLANTIC)).toBe(11);
    expect(localHourOf(Date.parse('2026-08-06T14:07:00Z'), 'UTC')).toBe(14);
  });

  it('follows the offset across the winter change instead of assuming one', () => {
    // In January the zone is UTC-4, not UTC-3; a fixed offset shifts every loss by an hour.
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
    // The memo cache must be keyed on zone as well as hour bucket; a cross-zone hit is
    // invisible in the output.
    const at = Date.parse('2026-08-06T14:07:00Z');
    expect(localHourOf(at, ATLANTIC)).toBe(11);
    expect(localHourOf(at, 'Pacific/Auckland')).toBe(2);
    expect(localHourOf(at, ATLANTIC)).toBe(11);
  });
});
