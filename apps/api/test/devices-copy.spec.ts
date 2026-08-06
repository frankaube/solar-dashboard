import { describe, expect, it } from 'vitest';
import {
  costIsEstimated,
  describeKind,
  describeState,
  headline,
  lastHeard,
  monthlyCost,
  usingNowKw,
} from '../../web/src/pages/devicesCopy';

/**
 * The naming rules from the Sunhouse redesign, tested where they live.
 *
 * The interesting part of that design is not the layout — it is that a state should say
 * what to do about it. `unreachable` and `no data yet` were both accurate and both
 * useless, and rendering them identically made every row look equally broken.
 */
const NOW = new Date('2026-07-30T12:00:00.000Z');

const device = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    vendor: 'kasa',
    kind: 'switch',
    name: 'Garage lights',
    host: '10.0.0.244',
    room: null,
    critical: false,
    enabled: true,
    config: '{}',
    capabilities: ['setOn'],
    state: { reachable: true, on: false, updatedAt: NOW.toISOString() },
    ...over,
  }) as never;

describe('naming a state', () => {
  it('calls an unreachable device "Lost contact" and says when it last spoke', () => {
    /*
      "Unreachable" reads like a property of the device. "Lost contact" names something
      that happened to it, which is the thing you can act on.
    */
    const state = describeState(
      device({ state: { reachable: false, updatedAt: '2026-07-27T12:00:00.000Z' } }),
      NOW,
    );
    expect(state.label).toBe('Lost contact');
    expect(state.tone).toBe('bad');
    expect(state.detail).toBe('Last heard 3 days ago');
  });

  it('calls a device that has never reported "Waiting", not broken', () => {
    // A device that has not spoken yet is not a fault and must not be coloured as one.
    const state = describeState(device({ state: null }), NOW);
    expect(state.label).toBe('Waiting');
    expect(state.tone).toBe('idle');
  });

  it('asks for a pairing code when that is what is missing', () => {
    const state = describeState(device({ vendor: 'mysa', kind: 'thermostat', config: null }), NOW);
    expect(state.label).toBe('Needs pairing');
    expect(state.detail).toBe('Enter the code on the device');
  });

  it('shows a thermostat as heating or idle with its temperatures', () => {
    const heating = describeState(
      device({
        kind: 'thermostat',
        vendor: 'mysa',
        state: { reachable: true, temperatureC: 19.4, setpointC: 21, heating: true, updatedAt: NOW.toISOString() },
      }),
      NOW,
    );
    expect(heating.label).toBe('Heating');
    expect(heating.detail).toBe('19.4° → 21.0°');
  });

  it('drops the signal strength from the surface entirely', () => {
    // "-55 dBm" was on every row and told a homeowner nothing.
    const state = describeState(device({ state: { reachable: true, on: true, rssi: -55, updatedAt: NOW.toISOString() } }), NOW);
    expect(state.label).toBe('On');
    expect(state.detail).toBeNull();
  });
});

describe('lastHeard', () => {
  it('reads in the units a person would use', () => {
    expect(lastHeard('2026-07-30T11:59:30.000Z', NOW)).toBe('just now');
    expect(lastHeard('2026-07-30T11:20:00.000Z', NOW)).toBe('40 minutes ago');
    expect(lastHeard('2026-07-30T06:00:00.000Z', NOW)).toBe('6 hours ago');
    expect(lastHeard('2026-07-27T12:00:00.000Z', NOW)).toBe('3 days ago');
  });

  it('says nothing rather than "Invalid Date"', () => {
    expect(lastHeard(undefined, NOW)).toBeNull();
    expect(lastHeard('not-a-date', NOW)).toBeNull();
  });
});

describe('the sentence at the top of the page', () => {
  const thermostat = (id: number, reachable: boolean) =>
    device({ id, kind: 'thermostat', vendor: 'mysa', name: `Mysa ${id}`, state: reachable ? { reachable: true, temperatureC: 20, updatedAt: NOW.toISOString() } : { reachable: false, updatedAt: NOW.toISOString() } });

  it('names the group when a whole kind fails together', () => {
    /*
      The design's own example. "Both thermostats have gone quiet" is one thing to go and
      look at; three warnings about three thermostats is a list to work through.
    */
    const result = headline(
      [thermostat(1, false), thermostat(2, false), device({ id: 3 }), device({ id: 4, name: 'Plug' })],
      NOW,
    );
    expect(result.sentence).toBe('Both thermostats have gone quiet. Nothing else is wrong.');
    expect(result.reporting).toBe(2);
    expect(result.total).toBe(4);
    expect(result.troubled).toBe(2);
  });

  it('uses the singular for one', () => {
    expect(headline([thermostat(1, false), device({ id: 2 })], NOW).sentence).toBe(
      'One thermostat has gone quiet. Nothing else is wrong.',
    );
  });

  it('drops the reassurance when nothing else is left to reassure about', () => {
    expect(headline([thermostat(1, false), thermostat(2, false)], NOW).sentence).toBe(
      'Both thermostats have gone quiet.',
    );
  });

  it('falls back to a count when several kinds are affected', () => {
    const result = headline(
      [thermostat(1, false), device({ id: 2, state: { reachable: false, updatedAt: NOW.toISOString() } }), device({ id: 3 })],
      NOW,
    );
    expect(result.sentence).toBe('2 devices have gone quiet. Nothing else is wrong.');
  });

  it('says so plainly when everything is fine', () => {
    expect(headline([device({ id: 1 }), device({ id: 2 })], NOW).sentence).toBe(
      'Everything is reporting. Nothing needs a look.',
    );
  });

  it('handles an empty install without inventing a problem', () => {
    expect(headline([], NOW).sentence).toBe('No devices yet. Add one to start watching it.');
  });
});

describe('the three numbers', () => {
  it('reports live draw only from devices that can measure it', () => {
    expect(
      usingNowKw([
        device({ state: { reachable: true, powerW: 150, updatedAt: NOW.toISOString() } }),
        device({ state: { reachable: true, powerW: 50, updatedAt: NOW.toISOString() } }),
      ]),
    ).toBeCloseTo(0.2, 6);
  });

  it('returns null, not zero, when nothing meters', () => {
    // A confident 0.0 kW is a lie when the truth is "nothing here can tell you".
    expect(usingNowKw([device(), device()])).toBeNull();
    expect(usingNowKw([])).toBeNull();
  });

  it('turns a week of energy into a monthly cost in units people use', () => {
    /*
      Cents, not kWh. "31¢ a month" decides whether you care; "1.9 kWh" does not.
    */
    const usage = [{ deviceId: 1, name: 'Garage lights', kind: 'switch', onHoursPerDay: 1.2, energyKwh: 0.42, metered: false, estimated: true, observations: [] }];
    expect(monthlyCost(usage as never, 0.177)).toBe('32¢ a month');
  });

  it('switches to dollars once it is worth dollars, and rounds them', () => {
    /*
      Whole dollars past ten, cents below it. The design asks for one number big enough to
      read across a kitchen, and "$30.34" spends two digits nobody acts on.
    */
    const heater = [{ deviceId: 1, name: 'Heater', kind: 'plug', onHoursPerDay: 8, energyKwh: 40, metered: true, observations: [] }];
    expect(monthlyCost(heater as never, 0.177)).toBe('$30 a month');
    const small = [{ deviceId: 1, name: 'Fan', kind: 'plug', onHoursPerDay: 2, energyKwh: 1.5, metered: true, observations: [] }];
    expect(monthlyCost(small as never, 0.177)).toBe('$1.14 a month');
  });

  it('says nothing rather than 0¢ when nothing is known', () => {
    expect(monthlyCost([], 0.177)).toBeNull();
    expect(monthlyCost([{ deviceId: 1, name: 'x', kind: 'plug', onHoursPerDay: 0, energyKwh: null, metered: false, observations: [] }] as never, 0.177)).toBeNull();
  });

  it('refuses to price anything without a rate', () => {
    const usage = [{ deviceId: 1, name: 'x', kind: 'plug', onHoursPerDay: 1, energyKwh: 1, metered: false, observations: [] }];
    expect(monthlyCost(usage as never, 0)).toBeNull();
  });

  it('knows when the whole figure rests on estimates', () => {
    const estimated = [{ deviceId: 1, name: 'x', kind: 'plug', onHoursPerDay: 1, energyKwh: 1, metered: false, observations: [] }];
    const measured = [{ deviceId: 1, name: 'x', kind: 'plug', onHoursPerDay: 1, energyKwh: 1, metered: true, observations: [] }];
    expect(costIsEstimated(estimated as never)).toBe(true);
    expect(costIsEstimated(measured as never)).toBe(false);
  });
});

describe('kind labels', () => {
  it('names the ones it knows and capitalises the rest', () => {
    expect(describeKind('thermostat')).toBe('Thermostat');
    expect(describeKind('plug')).toBe('Plug');
    expect(describeKind('doohickey')).toBe('Doohickey');
  });
});
