import { describe, expect, it } from 'vitest';
import { describeCarState, goeStatusUrl, parseGoeStatus, totalPowerW } from '../src/charger/goe.adapter';
import {
  applyOvmsMetric,
  emptyVehicle,
  parseOvmsBool,
  parseOvmsTopic,
} from '../src/vehicle/ovms';

/**
 * go-e field meanings are from the vendor's own apikeys-en.md, not from a device — there
 * is no go-e charger here. These tests pin the mapping and the defensive scaling; they do
 * not prove a charger agrees.
 */
describe('go-e status', () => {
  const charging = {
    fna: 'Garage',
    car: 2,
    alw: true,
    amp: 32,
    wh: 12500,
    eto: 1234500,
    // U(L1,L2,L3,N) I(L1,L2,L3) P(L1,L2,L3,N,Total) pf(L1,L2,L3,N)
    nrg: [239, 0, 0, 0, 31.5, 0, 0, 7360, 0, 0, 0, 7360, 1, 0, 0, 0],
  };

  it('reads the plain fields', () => {
    const status = parseGoeStatus(charging);
    expect(status.name).toBe('Garage');
    expect(status.charging).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.allowedToCharge).toBe(true);
    expect(status.requestedCurrentA).toBe(32);
    // Both wh and eto are documented in Wh, so no conversion.
    expect(status.sessionEnergyWh).toBe(12500);
    expect(status.lifetimeEnergyWh).toBe(1234500);
  });

  it('treats Idle as no car but Complete as still plugged in', () => {
    /*
      Complete (4) means the cable is attached and a schedule may resume. Calling that
      disconnected would make a car vanish from the page while it is sitting there.
    */
    expect(parseGoeStatus({ car: 1 }).connected).toBe(false);
    expect(parseGoeStatus({ car: 4 }).connected).toBe(true);
    expect(parseGoeStatus({ car: 3 }).connected).toBe(true);
    expect(parseGoeStatus({ car: 0 }).connected).toBe(false);
    expect(parseGoeStatus({}).connected).toBe(false);
  });

  it('names each car state', () => {
    expect(describeCarState(2)).toBe('charging');
    expect(describeCarState(1)).toBe('no car');
    expect(describeCarState(null)).toBe('no data');
  });

  describe('power scaling, derived rather than assumed', () => {
    /*
      The vendor reference documents the nrg layout but not the scale of its power
      entries, and v1 of this API reported power in a scaled form that caught people out.
      Guessing wrong is a 1000x error in a dollar figure, so the expected magnitude comes
      from the voltage and current the same array reports.
    */
    it('accepts watts when they match V x I', () => {
      expect(totalPowerW(charging.nrg)).toBe(7360);
    });

    it('scales kilowatts up when that is what matches', () => {
      const kw = [239, 0, 0, 0, 31.5, 0, 0, 7.36, 0, 0, 0, 7.36, 1, 0, 0, 0];
      expect(totalPowerW(kw)).toBeCloseTo(7360, 0);
    });

    it('reports zero as zero without guessing', () => {
      const idle = [239, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      expect(totalPowerW(idle)).toBe(0);
    });

    it('falls back to the raw value when there is no current to check against', () => {
      // The only case the cross-check cannot speak to — and also the case where the
      // answer is near zero either way.
      const noCurrent = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 0];
      expect(totalPowerW(noCurrent)).toBe(42);
    });

    it('returns null for a missing array', () => {
      expect(totalPowerW([])).toBeNull();
      expect(parseGoeStatus({ car: 2 }).powerW).toBeNull();
    });
  });

  it('asks the charger for only the keys it needs', () => {
    // go-e's own docs ask for a filter; an unfiltered V4 status is a large document to
    // fetch on every poll.
    expect(goeStatusUrl('10.0.0.50')).toContain('filter=');
    expect(goeStatusUrl('10.0.0.50')).toContain('nrg');
  });
});

/**
 * OVMS is the only genuinely local vehicle telemetry available — a dongle reading the
 * car's own CAN bus. Topic and metric names are from the OVMS documentation.
 */
describe('OVMS topics', () => {
  it('finds the vehicle and metric, ignoring the username in the middle', () => {
    // The username differs per install and is not ours to know, so the shape is matched
    // positionally.
    expect(parseOvmsTopic('ovms', 'ovms/owner/leaf1/metric/v/b/soc')).toEqual({
      vehicleId: 'leaf1',
      metric: 'v/b/soc',
    });
  });

  it('rejects topics that are not metrics', () => {
    expect(parseOvmsTopic('ovms', 'ovms/owner/leaf1/client/abc/command')).toBeNull();
    expect(parseOvmsTopic('ovms', 'ovms/owner/leaf1')).toBeNull();
    expect(parseOvmsTopic('ovms', 'evcc/site/pvPower')).toBeNull();
  });

  it('handles a multi-level prefix', () => {
    expect(parseOvmsTopic('home/ovms', 'home/ovms/owner/leaf1/metric/v/b/soc')?.metric).toBe('v/b/soc');
  });
});

describe('OVMS payloads', () => {
  it('reads yes/no rather than coercing it', () => {
    /*
      OVMS booleans are words. Boolean("no") is true, which would report every parked car
      as charging.
    */
    expect(parseOvmsBool('yes')).toBe(true);
    expect(parseOvmsBool('no')).toBe(false);
    expect(parseOvmsBool('maybe')).toBeNull();
  });

  const at = new Date('2026-07-29T18:00:00.000Z');

  it('folds metrics into a vehicle', () => {
    let car = emptyVehicle('leaf1');
    car = applyOvmsMetric(car, 'v/b/soc', '54.5', at);
    car = applyOvmsMetric(car, 'v/b/range/est', '310', at);
    car = applyOvmsMetric(car, 'v/c/charging', 'yes', at);
    expect(car.soc).toBe(54.5);
    expect(car.rangeEstKm).toBe(310);
    expect(car.charging).toBe(true);
    expect(car.updatedAt).toEqual(at);
  });

  it('flips the sign on battery power so charging is positive', () => {
    /*
      OVMS reports battery power from the battery's point of view: negative while
      charging. Left alone, a charging car would show negative watts while this app treats
      positive as charging everywhere else.
    */
    const car = applyOvmsMetric(emptyVehicle('leaf1'), 'v/b/power', '-7.36', at);
    expect(car.chargePowerW).toBe(7360);
    const discharging = applyOvmsMetric(emptyVehicle('leaf1'), 'v/b/power', '12.5', at);
    expect(discharging.chargePowerW).toBe(-12500);
  });

  it('ignores the hundreds of metrics a dashboard does not need', () => {
    const before = emptyVehicle('leaf1');
    const after = applyOvmsMetric(before, 'v/e/cabintemp', '21', at);
    // Returned unchanged, including updatedAt — an ignored metric is not an update.
    expect(after).toBe(before);
  });

  it('stores null rather than NaN for an unparseable number', () => {
    const car = applyOvmsMetric(emptyVehicle('leaf1'), 'v/b/soc', 'unknown', at);
    expect(car.soc).toBeNull();
  });
});
