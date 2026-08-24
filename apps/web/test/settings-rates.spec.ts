import { describe, expect, it } from 'vitest';
import { hstToFraction, hstToPercent, validateRates } from '../src/pages/settingsRates';

const OK = { price: '0.1489', ratedKw: '24', cost: '38000', hstPct: '15' };

/**
 * The endpoint rejects bad values with a 400, but the page used to swallow it — no
 * catch, no message, no "Saved". The save appeared to do nothing. These are the cases
 * that used to reach the server and come back invisible.
 */
describe('validateRates', () => {
  it('accepts a fully filled, sensible form', () => {
    expect(validateRates(OK)).toEqual({});
  });

  it('treats the three optional fields as optional, but not the price', () => {
    expect(validateRates({ price: '0.1489' })).toEqual({});
    expect(validateRates({ ...OK, price: '' })).toEqual({ price: 'Required.' });
  });

  it('rejects a blanked price rather than sending zero', () => {
    // Number('') is 0, which the old page sent as electricityPricePerKwh — the server
    // refused it and every savings figure would have been zeroed if it had not.
    expect(validateRates({ ...OK, price: '   ' })).toEqual({ price: 'Required.' });
  });

  it('rejects zero and negatives', () => {
    expect(validateRates({ ...OK, price: '0' }).price).toBe('Must be greater than zero.');
    expect(validateRates({ ...OK, cost: '-5' }).cost).toBe('Must be greater than zero.');
  });

  it('catches watts typed into the kW field', () => {
    expect(validateRates({ ...OK, ratedKw: '24000' }).ratedKw).toBe('Expected kilowatts, not watts.');
    expect(validateRates({ ...OK, ratedKw: '24' }).ratedKw).toBeUndefined();
  });

  it('catches a fraction typed into the percent field, and vice versa', () => {
    // 0.15 in a "%" box means 0.15% — legal, if unusual — so it passes. 150 does not.
    expect(validateRates({ ...OK, hstPct: '0.15' }).hstPct).toBeUndefined();
    expect(validateRates({ ...OK, hstPct: '150' }).hstPct).toBe('Enter a percentage, e.g. 15.');
  });

  it('reports every bad field at once, not just the first', () => {
    expect(validateRates({ price: '', ratedKw: '24000', cost: '0', hstPct: '150' })).toEqual({
      price: 'Required.',
      ratedKw: 'Expected kilowatts, not watts.',
      cost: 'Must be greater than zero.',
      hstPct: 'Enter a percentage, e.g. 15.',
    });
  });

  it('rejects text', () => {
    expect(validateRates({ ...OK, price: 'abc' }).price).toBe('Must be a number.');
  });
});

describe('HST unit conversion', () => {
  it('round-trips every real Canadian rate without altering it', () => {
    // 14.975% is Quebec's combined GST+QST — rounding the display to two decimal
    // places of percent turned it into 14.98% and saved that back.
    for (const fraction of [0.05, 0.13, 0.14975, 0.15]) {
      expect(hstToFraction(hstToPercent(fraction))).toBeCloseTo(fraction, 10);
    }
  });

  it('shows Quebec at full precision', () => {
    expect(hstToPercent(0.14975)).toBe('14.975');
  });

  it('does not leak binary floating point into the field', () => {
    // 0.15 * 100 is 15.000000000000002; the field must read "15".
    expect(hstToPercent(0.15)).toBe('15');
    expect(hstToPercent(0.13)).toBe('13');
  });
});
