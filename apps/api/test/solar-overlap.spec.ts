import { describe, expect, it } from 'vitest';
import { PowerSample, solarShareOf } from '../src/charger/solar-overlap';

/*
  Written after every charge since 28 July lost its solar figure: the share was computed
  only from Wall Connector readings, and the Wall Connector stopped answering. The car
  records the same thing, so the maths moved somewhere both can reach it.
*/

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 7, 2, 15, 0); // a midday charge

/** A steady draw, one sample a minute. */
const steady = (watts: number, minutes: number): PowerSample[] =>
  Array.from({ length: minutes + 1 }, (_, i) => ({ t: T0 + i * MINUTE, w: watts }));

const production = (watts: number, minutes: number): PowerSample[] =>
  Array.from({ length: minutes + 1 }, (_, i) => ({ t: T0 + i * MINUTE, w: watts }));

describe('solarShareOf', () => {
  it('is all solar when the roof out-makes the draw', () => {
    const share = solarShareOf(steady(6_000, 60), production(10_000, 60));
    expect(share.solarPct).toBe(100);
    expect(share.solarWh).toBe(6_000);
  });

  it('takes the smaller of the two, minute by minute', () => {
    /*
      Not "was the sun up". Drawing 11 kW while the array makes 3 kW is 3 kW of sunshine
      and 8 kW of grid in the same minute — the whole point of integrating the minimum.
    */
    const share = solarShareOf(steady(12_000, 60), production(3_000, 60));
    expect(share.solarWh).toBe(3_000);
    expect(share.solarPct).toBe(25);
  });

  it('is nothing at night', () => {
    expect(solarShareOf(steady(11_000, 60), production(0, 60))).toEqual({ solarWh: 0, solarPct: 0 });
  });

  it('scores a gap in production as no sun, not as stale sun', () => {
    // One reading an hour old says nothing about now. Treating it as current would credit
    // a night charge with the afternoon's output.
    const stale = [{ t: T0 - 3 * 60 * MINUTE, w: 9_000 }];
    expect(solarShareOf(steady(5_000, 30), stale).solarPct).toBe(0);
  });

  it('does not invent energy across a logging outage', () => {
    /*
      Two samples six hours apart. Without a cap on the step, the first is integrated over
      the whole gap and manufactures kilowatt-hours of sunshine out of a dropout.
    */
    const sparse: PowerSample[] = [
      { t: T0, w: 10_000 },
      { t: T0 + 360 * MINUTE, w: 10_000 },
    ];
    const share = solarShareOf(sparse, production(10_000, 400));
    // Capped at the 2-minute step: 10 kW for 2 minutes, not for six hours.
    expect(share.solarWh).toBeLessThan(400);
  });

  it('never reports more solar than the charge delivered', () => {
    // The meter's total wins over the integral. A share above the energy actually
    // delivered is arithmetic that escaped its own premise.
    const share = solarShareOf(steady(11_000, 60), production(11_000, 60), 5_000);
    expect(share.solarWh).toBe(5_000);
    expect(share.solarPct).toBe(100);
  });

  it('falls back to integrating the draw when no meter total is given', () => {
    const share = solarShareOf(steady(10_000, 30), production(5_000, 30));
    expect(share.solarPct).toBe(50);
  });

  it('says nothing rather than guessing from a single sample', () => {
    expect(solarShareOf([{ t: T0, w: 11_000 }], production(10_000, 60))).toEqual({
      solarWh: 0,
      solarPct: 0,
    });
  });

  it('handles no production data at all', () => {
    expect(solarShareOf(steady(11_000, 60), [])).toEqual({ solarWh: 0, solarPct: 0 });
  });

  it('tracks production that changes during the charge', () => {
    // Cloud passing: full sun for the first half, nothing for the second.
    const half: PowerSample[] = [
      ...Array.from({ length: 31 }, (_, i) => ({ t: T0 + i * MINUTE, w: 10_000 })),
      ...Array.from({ length: 30 }, (_, i) => ({ t: T0 + (31 + i) * MINUTE, w: 0 })),
    ];
    const share = solarShareOf(steady(10_000, 60), half);
    expect(share.solarPct).toBeGreaterThan(45);
    expect(share.solarPct).toBeLessThan(55);
  });
});
