import { describe, expect, it } from 'vitest';
import { ago, instant, kwh, kwhDirect, money, num, pct, volts, watts } from '../src/format.mjs';

/*
  The whole reason rendering happens here instead of handing over raw JSON: a model reading
  `todayEnergyWh: 21400` will report "21,400 kWh" and sound completely sure. Units travel
  with the number or they do not travel.
*/

describe('units', () => {
  it('keeps the unit attached', () => {
    expect(watts(4180)).toBe('4,180 W');
    expect(kwh(21_400)).toBe('21.4 kWh');
    expect(kwhDirect(21.4)).toBe('21.4 kWh');
    expect(money(1234.5)).toBe('$1,234.50');
    expect(pct(63.7)).toBe('64%');
    expect(volts(243.05)).toBe('243.1 V');
  });

  it('never rounds money to whole dollars', () => {
    // "$1" beside "$0.81" reads as a different precision than it is — a real UI defect once.
    expect(money(1)).toBe('$1.00');
    expect(money(0.81)).toBe('$0.81');
  });

  it('does not divide by a thousand twice', () => {
    // kwh takes watt-hours; kwhDirect takes kilowatt-hours. Conflating them is a 1000x error.
    expect(kwh(1000)).toBe('1.0 kWh');
    expect(kwhDirect(1000)).toBe('1,000.0 kWh');
  });
});

describe('absent versus zero', () => {
  it('says unknown rather than printing a zero it does not have', () => {
    /*
      The collapse this project keeps finding: a missing grid voltage rendered as "0 V" is
      indistinguishable from a measured zero, and nothing downstream can recover which it
      was.
    */
    for (const absent of [null, undefined, NaN, Infinity, 'x']) {
      expect(watts(absent)).toBe('unknown');
      expect(kwh(absent)).toBe('unknown');
      expect(money(absent)).toBe('unknown');
      expect(pct(absent)).toBe('unknown');
      expect(num(absent)).toBe('unknown');
    }
  });

  it('keeps a real zero', () => {
    expect(watts(0)).toBe('0 W');
    expect(kwh(0)).toBe('0.0 kWh');
    expect(money(0)).toBe('$0.00');
  });
});

describe('ago', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');

  it('scales the unit to the gap', () => {
    expect(ago('2026-08-04T11:59:19Z', now)).toBe('41 s ago');
    expect(ago('2026-08-04T11:38:00Z', now)).toBe('22 min ago');
    expect(ago('2026-08-04T08:48:00Z', now)).toBe('3 h 12 min ago');
    expect(ago('2026-08-04T09:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-07-30T12:00:00Z', now)).toBe('5 days ago');
  });

  it('reports elapsed time rather than a wall clock', () => {
    /*
      This process runs on the assistant's machine, which need not share a timezone with
      the array. "13:22" would be a plausible-looking lie; an elapsed duration is true
      everywhere.
    */
    expect(instant('2026-08-04T11:38:00Z', now)).toBe('2026-08-04T11:38:00Z (22 min ago)');
  });

  it('names clock skew instead of reporting a negative age', () => {
    expect(ago('2026-08-04T12:05:00Z', now)).toMatch(/clock skew/);
  });

  it('returns null for a timestamp it cannot read', () => {
    expect(ago(null, now)).toBeNull();
    expect(ago('never', now)).toBeNull();
    expect(instant(undefined, now)).toBe('unknown');
  });
});
