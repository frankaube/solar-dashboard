import { describe, expect, it } from 'vitest';
import { madeTodayHint } from '../src/pages/energyHint';

/*
  The hover under "Made today".

  The caption beside it says "85 yesterday", a whole day, which a part-day cannot be measured
  against until sunset. This is the comparison that can be: the same hour, the day before.
*/

describe('madeTodayHint', () => {
  it('names yesterday at this hour, and where today stands against it', () => {
    /*
      5 kWh so far against 12 by this time yesterday: behind, and by how much.

      Whole kWh above ten and a decimal below, which is the rule the tile and the money
      figures already follow — precision belongs where the number is small enough for it to
      mean something. So the total reads "12" while the gap beneath it reads "7.4".
    */
    expect(madeTodayHint(5_000, 12_400, false)).toBe(
      '12 kWh by this time yesterday · 7.4 kWh behind',
    );
  });

  it('says ahead when the roof is ahead', () => {
    expect(madeTodayHint(14_000, 9_500, false)).toBe(
      '9.5 kWh by this time yesterday · 4.5 kWh ahead',
    );
  });

  it('calls a gap smaller than the rounding "level" rather than implying one', () => {
    /*
      Both render as the same number on the tile, so "0.0 kWh ahead" would invite the reader
      to look for a difference the display cannot show them.
    */
    expect(madeTodayHint(12_040, 12_000, false)).toBe(
      '12 kWh by this time yesterday · about level',
    );
  });

  it('says nothing when the server could not say', () => {
    // An install younger than a day, or a collection gap across that moment. Not a zero.
    expect(madeTodayHint(5_000, null, false)).toBeUndefined();
  });

  it('says nothing once the tile has flipped to yesterday after dark', () => {
    /*
      The number above it is then yesterday's whole day, and "by this time yesterday" would
      be describing the day before that — a comparison between two different things.
    */
    expect(madeTodayHint(85_000, 12_400, true)).toBeUndefined();
  });

  it('keeps whole numbers above ten kWh, matching the tile it hangs off', () => {
    // The tile renders 85, not 85.0; a hover disagreeing with it reads as a second figure.
    expect(madeTodayHint(90_000, 85_000, false)).toBe('85 kWh by this time yesterday · 5.0 kWh ahead');
  });

  it('handles a yesterday that had made nothing yet', () => {
    // Before sunrise the counter is a real zero, which is a measurement rather than a gap.
    expect(madeTodayHint(300, 0, false)).toBe('0.0 kWh by this time yesterday · 0.3 kWh ahead');
  });
});
