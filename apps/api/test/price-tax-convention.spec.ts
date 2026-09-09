import { describe, expect, it } from 'vitest';
import { resolveProgram, valueProgram } from '../src/readings/reward-programs';

/**
 * The engine expects a tax-INCLUSIVE retail price: an exported kWh is banked 1:1 and
 * redeemed with tax still payable, so it returns retail/(1+tax), while a self-consumed one
 * avoids the whole retail price including the tax.
 *
 * Utility bills print the pre-tax energy rate, so entering that instead understates every
 * dollar figure by the tax, silently.
 */
const HST = 0.15;
const PRE_TAX = 0.1539;
const WITH_TAX = PRE_TAX * (1 + HST);

const value = (retail: number, produced: number, selfConsumed: number) =>
  valueProgram(
    resolveProgram('net-metering', { taxRate: HST, retailPerKwh: retail }),
    { producedKwh: produced, selfConsumedKwh: selfConsumed, exportedKwh: produced - selfConsumed },
    retail,
  );

describe('the tax convention on the configured price', () => {
  it('values an exported kWh at the pre-tax rate when the price includes tax', () => {
    // 1 kWh, none of it self-consumed: banked and redeemed, tax paid on redemption.
    expect(value(WITH_TAX, 1, 0).realised).toBeCloseTo(PRE_TAX, 4);
  });

  it('values a self-consumed kWh at the full retail price', () => {
    // Never bought, so the tax is never paid either.
    expect(value(WITH_TAX, 1, 1).realised).toBeCloseTo(WITH_TAX, 4);
  });

  it('makes self-consumption worth exactly the tax more', () => {
    const gap = value(WITH_TAX, 1, 1).realised - value(WITH_TAX, 1, 0).realised;
    expect(gap).toBeCloseTo(PRE_TAX * HST, 4);
  });

  it('is understated by the whole tax if the pre-tax rate is entered instead', () => {
    // Feeding the engine 15.39 c makes an exported kWh worth 13.38 c — the pre-tax rate
    // of a pre-tax rate — when it should be worth 15.39 c.
    const wrong = value(PRE_TAX, 1, 0).realised;
    const right = value(WITH_TAX, 1, 0).realised;
    expect(wrong).toBeCloseTo(0.1338, 4);
    expect(right).toBeCloseTo(0.1539, 4);
    expect(right / wrong).toBeCloseTo(1 + HST, 3);
  });

  it('leaves a tax-free jurisdiction unaffected either way', () => {
    // With no tax the two conventions coincide and self-consumption carries no premium.
    const program = resolveProgram('net-metering', { taxRate: 0, retailPerKwh: 0.2 });
    const exported = valueProgram(program, { producedKwh: 1, selfConsumedKwh: 0, exportedKwh: 1 }, 0.2);
    const selfUsed = valueProgram(program, { producedKwh: 1, selfConsumedKwh: 1, exportedKwh: 0 }, 0.2);
    expect(exported.realised).toBeCloseTo(0.2, 6);
    expect(selfUsed.realised).toBeCloseTo(0.2, 6);
  });
});

describe('a self-consumption assumption', () => {
  /*
    Applied as a floor over the measured figure, never replacing it: only solar diverted to
    an EV or battery is measurable, so the measurement is a hard lower bound.
  */
  const floor = (measuredKwh: number, producedKwh: number, pct: number): number =>
    Math.max(measuredKwh, producedKwh * (pct / 100));

  it('lifts a measurement that is obviously too low', () => {
    // Measured 5 kWh of 581 (1%), because only the EV and battery are countable.
    expect(floor(5, 581, 35)).toBeCloseTo(203.35, 2);
  });

  it('never discards a measurement that already exceeds it', () => {
    // A day of deliberate EV charging can beat any annual average.
    expect(floor(400, 581, 35)).toBe(400);
  });

  it('changes nothing when unset', () => {
    expect(floor(5, 581, 0)).toBe(5);
  });

  it('turns the assumption into money at the tax rate, not the retail rate', () => {
    // A kWh is credited at the pre-tax rate whatever happens to it, so the assumption only
    // decides who keeps the tax — not 15.39 c per kWh.
    const produced = 581;
    const cautious = value(WITH_TAX, produced, floor(5, produced, 0));
    const assumed = value(WITH_TAX, produced, floor(5, produced, 35));
    const gap = assumed.realised - cautious.realised;
    expect(gap).toBeCloseTo((203.35 - 5) * PRE_TAX * HST, 2);
    // About $4.58 across 581 kWh.
    expect(gap).toBeGreaterThan(4);
    expect(gap).toBeLessThan(5);
  });
});
