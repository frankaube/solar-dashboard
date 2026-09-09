import { describe, expect, it } from 'vitest';
import { rangeAvailable } from '../src/pages/TrendsPage';

/*
  Which ranges the Trends selector should offer. With a fortnight of history, 30 days, 90 days
  and a year are all the same fortnight, and a control that responds while changing nothing
  reads as a bug in the data.
*/

describe('rangeAvailable', () => {
  it('always offers the shortest range', () => {
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
    // The test is whether the ranges can differ, not whether the longer one is full.
    expect(rangeAvailable('90 d', 31)).toBe(true);
    expect(rangeAvailable('12 mo', 31)).toBe(true);
  });

  it('offers everything while the history length is still unknown', () => {
    // The records call has not landed yet; disabling on a guess greys out working buttons.
    expect(rangeAvailable('90 d', null)).toBe(true);
    expect(rangeAvailable('12 mo', null)).toBe(true);
  });

  it('is exactly at the boundary, not near it', () => {
    // 30 days of data: a 90-day view still shows the same 30. One more day and it does not.
    expect(rangeAvailable('90 d', 30)).toBe(false);
    expect(rangeAvailable('90 d', 31)).toBe(true);
  });
});
