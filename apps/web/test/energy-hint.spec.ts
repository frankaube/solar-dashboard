import { describe, expect, it } from 'vitest';
import { madeTodayHint } from '../src/pages/energyHint';

/*
  The hover under "Made today". The caption beside it is a whole day, which a part-day cannot
  be measured against until sunset; this compares the same hour, the day before.
*/

describe('madeTodayHint', () => {
  it('names yesterday at this hour, and where today stands against it', () => {
    // Whole kWh above ten and a decimal below, as the tile and money figures do.
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
    // Both render as the same number on the tile.
    expect(madeTodayHint(12_040, 12_000, false)).toBe(
      '12 kWh by this time yesterday · about level',
    );
  });

  it('says nothing when the server could not say', () => {
    // An install younger than a day, or a collection gap across that moment. Not a zero.
    expect(madeTodayHint(5_000, null, false)).toBeUndefined();
  });

  it('says nothing once the tile has flipped to yesterday after dark', () => {
    // The number above is then yesterday's whole day, so this would mean the day before.
    expect(madeTodayHint(85_000, 12_400, true)).toBeUndefined();
  });

  it('keeps whole numbers above ten kWh, matching the tile it hangs off', () => {
    // The tile renders 85, not 85.0; a hover disagreeing reads as a second figure.
    expect(madeTodayHint(90_000, 85_000, false)).toBe('85 kWh by this time yesterday · 5.0 kWh ahead');
  });

  it('handles a yesterday that had made nothing yet', () => {
    // Before sunrise the counter is a real zero, which is a measurement rather than a gap.
    expect(madeTodayHint(300, 0, false)).toBe('0.0 kWh by this time yesterday · 0.3 kWh ahead');
  });
});
