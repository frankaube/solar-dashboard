import { describe, expect, it } from 'vitest';
import {
  parseLoadpoint,
  parseState,
  primaryLoadpoint,
  solarChargedWh,
  unwrap,
} from '../src/evcc/evcc-state';

/**
 * Shapes taken from evcc's documented REST and MQTT field names, NOT from a live
 * instance — there is none to test against here. So these tests pin the mapping and the
 * tolerance for shape drift; they do not prove evcc agrees. Implementing a documented
 * schema proves you can parse the document.
 */
const SAMPLE = {
  result: {
    siteTitle: 'Home',
    pvPower: 4210,
    homePower: 730,
    battery: { soc: 62 },
    loadpoints: [
      {
        title: 'Garage',
        connected: true,
        charging: true,
        chargePower: 7360,
        sessionEnergy: 12.5,
        sessionSolarPercentage: 68,
        vehicleTitle: 'Ioniq 5',
        vehicleName: 'ioniq',
        vehicleSoc: 54,
        vehicleRange: 310,
        phasesActive: 1,
        mode: 'pv',
      },
      {
        title: 'Driveway',
        connected: false,
        charging: false,
        chargePower: 0,
        sessionEnergy: 0,
        sessionSolarPercentage: 0,
        mode: 'off',
      },
    ],
    vehicles: { ioniq: { title: 'Ioniq 5' }, leaf: { title: 'Leaf' } },
  },
};

describe('unwrapping the response', () => {
  it('accepts the wrapped shape', () => {
    expect(unwrap({ result: { pvPower: 1 } })).toEqual({ pvPower: 1 });
  });

  it('accepts the unwrapped shape', () => {
    /*
      evcc removed the `result` wrapper in a breaking change. Handling both means the
      adapter does not break on somebody else's release schedule — the alternative is an
      integration that works until the day an owner updates evcc.
    */
    expect(unwrap({ pvPower: 1 })).toEqual({ pvPower: 1 });
  });

  it('does not throw on rubbish', () => {
    expect(unwrap(null)).toEqual({});
    expect(unwrap('nope')).toEqual({});
  });
});

describe('parsing evcc state', () => {
  const state = parseState(SAMPLE);

  it('reads the site figures', () => {
    expect(state.siteTitle).toBe('Home');
    expect(state.pvPowerW).toBe(4210);
    expect(state.homePowerW).toBe(730);
  });

  it('finds battery soc whether nested or flat', () => {
    expect(state.batterySoc).toBe(62);
    expect(parseState({ batterySoc: 41 }).batterySoc).toBe(41);
  });

  it('numbers loadpoints from 1, as evcc does', () => {
    // So "loadpoint 2" means the same thing in a support conversation as it does in
    // evcc's own UI and MQTT topics.
    expect(state.loadpoints.map((lp) => lp.index)).toEqual([1, 2]);
  });

  it('converts session energy from kWh to Wh at the boundary', () => {
    // Everything internal to this app is Wh; converting here keeps that rule intact.
    expect(state.loadpoints[0].sessionEnergyWh).toBe(12500);
  });

  it('prefers the human vehicle title over the internal id', () => {
    expect(state.loadpoints[0].vehicleTitle).toBe('Ioniq 5');
    expect(parseLoadpoint({ vehicleName: 'ioniq' }, 1).vehicleTitle).toBe('ioniq');
  });

  it('reads the vehicle list from a map or an array', () => {
    expect(state.vehicleTitles.sort()).toEqual(['Ioniq 5', 'Leaf']);
    expect(parseState({ vehicles: [{ title: 'Bolt' }] }).vehicleTitles).toEqual(['Bolt']);
  });

  it('falls back to the map key when a vehicle has no title', () => {
    expect(parseState({ vehicles: { leaf: {} } }).vehicleTitles).toEqual(['leaf']);
  });

  it('survives an empty or unfamiliar payload', () => {
    const empty = parseState({});
    expect(empty.loadpoints).toEqual([]);
    expect(empty.pvPowerW).toBeNull();
    expect(parseState(null).loadpoints).toEqual([]);
  });

  it('does not invent a soc for a loadpoint with no car attached', () => {
    // 0% and "unknown" are different things: one means an empty battery.
    expect(state.loadpoints[1].vehicleSoc).toBeNull();
    expect(state.loadpoints[1].vehicleTitle).toBeNull();
  });
});

describe('choosing which loadpoint to show', () => {
  it('prefers one that is charging', () => {
    expect(primaryLoadpoint(parseState(SAMPLE))?.title).toBe('Garage');
  });

  it('falls back to one that is merely plugged in', () => {
    const idle = parseState({
      loadpoints: [
        { title: 'A', connected: false, charging: false },
        { title: 'B', connected: true, charging: false },
      ],
    });
    expect(primaryLoadpoint(idle)?.title).toBe('B');
  });

  it('falls back to the first when nothing is happening', () => {
    /*
      Without this ordering a two-charger house shows whichever evcc listed first, which
      is the idle one about half the time.
    */
    const cold = parseState({ loadpoints: [{ title: 'A' }, { title: 'B' }] });
    expect(primaryLoadpoint(cold)?.title).toBe('A');
  });

  it('returns null rather than throwing when there are none', () => {
    expect(primaryLoadpoint(parseState({}))).toBeNull();
  });
});

describe('solar energy actually delivered to cars', () => {
  it('is the one genuinely measured self-consumption figure available', () => {
    /*
      12.5 kWh at 68% solar. This matters because self-consumption is otherwise the
      owner's estimate — only a device sitting between the array and the load can see
      energy going into the house rather than out to the grid, and evcc is one.
    */
    expect(solarChargedWh(parseState(SAMPLE))).toBe(8500);
  });

  it('reports nothing rather than zero when evcc has not measured it', () => {
    // Zero would be indistinguishable from "charged entirely from the grid", and would
    // quietly get treated as a measurement.
    expect(solarChargedWh(parseState({ loadpoints: [{ sessionEnergy: 5 }] }))).toBeNull();
    expect(solarChargedWh(parseState({}))).toBeNull();
  });

  it('adds up across several charge points', () => {
    const two = parseState({
      loadpoints: [
        { sessionEnergy: 10, sessionSolarPercentage: 50 },
        { sessionEnergy: 4, sessionSolarPercentage: 25 },
      ],
    });
    expect(solarChargedWh(two)).toBe(6000);
  });
});
