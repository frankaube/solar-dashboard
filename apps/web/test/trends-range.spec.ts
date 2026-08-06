import { describe, expect, it } from 'vitest';
import { rangeAvailable } from '../src/pages/TrendsPage';

/*
  Which ranges the Trends selector should offer.

  Reported as "these buttons do nothing", and they did not — on an install with a fortnight
  of history, 30 days, 90 days and a year are all the same fortnight. The click registered,
  the refetch fired, the chart redrew identically. A control that responds and changes
  nothing is worse than one that is plainly unavailable, because the first looks like a bug
  in the data and the second explains itself.
*/

describe('rangeAvailable', () => {
  it('always offers the shortest range', () => {
    // There has to be something to click, whatever the history looks like.
    expect(rangeAvailable('30 d', 0)).toBe(true);
    expect(rangeAvailable('30 d', 15)).toBe(true);
    expect(rangeAvailable('30 d', 900)).toBe(true);
  });

  it('withholds the longer ones until history reaches past the shortest', () => {
    // 15 days of data cannot make a 90-day view differ from a 30-day one.
    expect(rangeAvailable('90 d', 15)).toBe(false);
    expect(rangeAvailable('12 mo', 15)).toBe(false);
  });

  it('opens them as soon as there is more than the shortest range holds', () => {
    /*
      31 days is enough for 90 d to show something 30 d does not, even though it is nowhere
      near 90. The test is whether the ranges can differ, not whether the longer one is full.
    */
    expect(rangeAvailable('90 d', 31)).toBe(true);
    expect(rangeAvailable('12 mo', 31)).toBe(true);
  });

  it('offers everything while the history length is still unknown', () => {
    // The records call has not landed yet. Disabling on a guess would grey out working
    // buttons for a moment on every page load, which is its own small lie.
    expect(rangeAvailable('90 d', null)).toBe(true);
    expect(rangeAvailable('12 mo', null)).toBe(true);
  });

  it('is exactly at the boundary, not near it', () => {
    // 30 days of data: a 90-day view still shows the same 30. One more day and it does not.
    expect(rangeAvailable('90 d', 30)).toBe(false);
    expect(rangeAvailable('90 d', 31)).toBe(true);
  });
});
