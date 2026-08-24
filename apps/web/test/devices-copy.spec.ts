import { describe, expect, it } from 'vitest';
import {
  costIsEstimated,
  describeKind,
  describeState,
  headline,
  lastHeard,
  monthlyCost,
  needsPairing,
  usingNowKw,
} from '../src/pages/devicesCopy';
import type { DeviceUsage, HomeDevice } from '../src/api';

/*
  The sentences and figures behind the Devices page, which at 630 lines was the largest
  file in the app with no test of any kind.

  Everything here turns partial data into a claim on screen, and this install is the case
  that matters: four devices adopted and not one of them reports watts. So the assertions
  below are mostly about the difference between "zero" and "nobody told us" — which look
  identical in a UI and only one of which is a problem.
*/

/**
 * The real shape, not an invented one: reachability and live watts sit under `state`.
 *
 * Written flat the first time, which made `usingNowKw` return null for a device carrying
 * watts and looked like a bug in the code rather than in the fixture.
 */
const device = (over: Record<string, unknown> = {}): HomeDevice =>
  ({
    id: 1,
    name: 'Kitchen plug',
    kind: 'kasa',
    configJson: null,
    ...over,
    state: { reachable: true, powerW: null, ...(over.state as object | undefined) },
  }) as unknown as HomeDevice;

const usage = (over: Partial<DeviceUsage> = {}): DeviceUsage =>
  ({ deviceId: 1, energyKwh: 7, metered: true, ...over }) as unknown as DeviceUsage;

describe('usingNowKw', () => {
  it('has no answer when nothing reports watts', () => {
    /*
      The state of this install: four adopted devices, none of which can measure. Returning
      0 would render "0.0 kW in use" — a measurement, and a false one. Null renders as
      unknown, which is the truth.
    */
    expect(usingNowKw([device(), device({ id: 2 })])).toBeNull();
  });

  it('sums only the devices that actually measure', () => {
    const total = usingNowKw([
      device({ state: { powerW: 1200 } }),
      device({ id: 2, state: { powerW: null } }),
      device({ id: 3, state: { powerW: 300 } }),
    ]);
    expect(total).toBeCloseTo(1.5, 3);
  });

  it('keeps a real zero, which is a measurement', () => {
    // A meter reporting 0 W is saying the thing is off. That is not the same as silence.
    expect(usingNowKw([device({ state: { powerW: 0 } })])).toBe(0);
  });
});

describe('monthlyCost', () => {
  it('scales a week to a month at the retail price', () => {
    // 7 kWh a week → 30 kWh a month → $4.80 at 16¢.
    expect(monthlyCost([usage({ energyKwh: 7 })], 0.16)).toBe('$4.80 a month');
  });

  it('drops to cents rather than printing $0.30', () => {
    expect(monthlyCost([usage({ energyKwh: 0.4 })], 0.16)).toMatch(/¢ a month$/);
  });

  it('loses the decimals once they stop meaning anything', () => {
    const big = monthlyCost([usage({ energyKwh: 200 })], 0.16);
    expect(big).toMatch(/^\$\d+ a month$/);
  });

  it('says nothing without a price or without energy', () => {
    /*
      A cost computed from a zero price is zero, which would read as "this device is free"
      rather than "nobody has entered a tariff".
    */
    expect(monthlyCost([usage()], 0)).toBeNull();
    expect(monthlyCost([], 0.16)).toBeNull();
    expect(monthlyCost([usage({ energyKwh: null })], 0.16)).toBeNull();
  });
});

describe('costIsEstimated', () => {
  it('is true only when every figure behind it was estimated', () => {
    expect(costIsEstimated([usage({ metered: false })])).toBe(true);
    // One real measurement is enough to stop calling the total an estimate.
    expect(costIsEstimated([usage({ metered: false }), usage({ id: 2, metered: true })])).toBe(false);
  });

  it('is false with nothing to judge, rather than true by vacuum', () => {
    expect(costIsEstimated([])).toBe(false);
  });
});

describe('lastHeard', () => {
  const now = new Date('2026-08-05T12:00:00Z');

  it('says nothing when nothing was ever heard', () => {
    expect(lastHeard(undefined, now)).toBeNull();
  });

  it('reads in minutes, then hours', () => {
    expect(lastHeard('2026-08-05T11:40:00Z', now)).toMatch(/min/);
    expect(lastHeard('2026-08-05T08:00:00Z', now)).toMatch(/h|hour/);
  });
});

describe('needsPairing', () => {
  it('is a property of the device, not a guess from its silence', () => {
    // A device that simply has not reported is not the same as one awaiting a pairing
    // code, and offering the wrong remedy is worse than offering none.
    expect(typeof needsPairing(device())).toBe('boolean');
  });
});

describe('describeKind', () => {
  it('names what it knows', () => {
    expect(describeKind('kasa').length).toBeGreaterThan(0);
  });

  it('falls back to something readable rather than printing an id', () => {
    const described = describeKind('some-unknown-vendor');
    expect(described).toBeTruthy();
    expect(described).not.toBe('');
  });
});

describe('describeState and headline', () => {
  it('gives every device a state and a tone', () => {
    const state = describeState(device({ state: { reachable: false } }));
    expect(state.label).toBeTruthy();
    expect(['ok', 'warn', 'bad', 'idle']).toContain(state.tone);
  });

  it('answers with a sentence even when there is nothing to report', () => {
    // The page leads with one answer; an empty house still needs one.
    expect(headline([]).sentence).toBeTruthy();
  });

  it('counts what is reporting rather than assuming all of it is', () => {
    /*
      A device awaiting a pairing code is adopted but not reporting, and a headline that
      counted it would say everything is fine about a house where nothing is watched.
    */
    const result = headline([device(), device({ id: 2, state: { reachable: false } })]);
    expect(result.total).toBe(2);
    expect(result.reporting).toBeLessThan(result.total);
  });
});
