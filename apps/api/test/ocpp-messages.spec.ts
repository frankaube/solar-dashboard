import { describe, expect, it } from 'vitest';
import {
  callError,
  callResult,
  chargePointIdFromPath,
  parseCall,
  parseMeterValues,
  replyFor,
  statusMeansConnected,
} from '../src/ocpp/ocpp-messages';

const NOW = new Date('2026-07-29T18:00:00.000Z');

describe('OCPP framing', () => {
  it('reads a CALL', () => {
    const call = parseCall('[2,"abc123","Heartbeat",{}]');
    expect(call?.action).toBe('Heartbeat');
    expect(call?.id).toBe('abc123');
  });

  it('ignores replies to us and anything malformed', () => {
    // A central system that tries to parse its own CALLRESULT echoes goes in circles.
    expect(parseCall('[3,"abc123",{}]')).toBeNull();
    expect(parseCall('[4,"abc123","GenericError","",{}]')).toBeNull();
    expect(parseCall('not json')).toBeNull();
    expect(parseCall('[2,"abc"]')).toBeNull();
    expect(parseCall('[2,123,"Heartbeat",{}]')).toBeNull();
  });

  it('tolerates a missing payload', () => {
    expect(parseCall('[2,"a","Heartbeat",null]')?.payload).toEqual({});
  });

  it('emits the wire shapes', () => {
    expect(callResult('a', { status: 'Accepted' })).toBe('[3,"a",{"status":"Accepted"}]');
    expect(callError('a', 'GenericError', 'nope')).toBe('[4,"a","GenericError","nope",{}]');
  });

  it('takes the charge point id from the URL path, which is all it has', () => {
    // OCPP-J identifies the charge point in the path; before BootNotification there is
    // nothing else to go on.
    expect(chargePointIdFromPath('/CP0001')).toBe('CP0001');
    expect(chargePointIdFromPath('/ocpp/CP0001?x=1')).toBe('CP0001');
    expect(chargePointIdFromPath('/')).toBeNull();
    expect(chargePointIdFromPath(undefined)).toBeNull();
  });
});

describe('replies', () => {
  it('accepts a boot and gives a heartbeat interval', () => {
    const reply = replyFor('BootNotification', NOW);
    expect(reply.status).toBe('Accepted');
    expect(reply.currentTime).toBe(NOW.toISOString());
    expect(reply.interval).toBe(300);
  });

  it('authorises, because refusing only stops the owner charging their own car', () => {
    expect(replyFor('Authorize', NOW)).toEqual({ idTagInfo: { status: 'Accepted' } });
    const start = replyFor('StartTransaction', NOW) as { idTagInfo: { status: string } };
    expect(start.idTagInfo.status).toBe('Accepted');
  });

  it('answers an unknown action with an empty result rather than an error', () => {
    /*
      A CALLERROR makes a charge point retry forever or drop the connection. This is here
      to watch, not to police, so anything unrecognised is acknowledged.
    */
    expect(replyFor('SomeVendorExtension', NOW)).toEqual({});
  });
});

describe('MeterValues', () => {
  it('scales kW and kWh to W and Wh', () => {
    /*
      Charge points declare their own units and disagree. Assuming one is a 1000x error
      in a number that ends up in a dollar figure.
    */
    const readings = parseMeterValues({
      meterValue: [
        {
          timestamp: '2026-07-29T18:00:00Z',
          sampledValue: [
            { value: '7.36', measurand: 'Power.Active.Import', unit: 'kW' },
            { value: '1234.5', measurand: 'Energy.Active.Import.Register', unit: 'kWh' },
          ],
        },
      ],
    });
    expect(readings[0].powerW).toBeCloseTo(7360, 3);
    expect(readings[0].energyWh).toBeCloseTo(1234500, 3);
  });

  it('leaves W and Wh alone', () => {
    const readings = parseMeterValues({
      meterValue: [
        {
          sampledValue: [
            { value: '7360', measurand: 'Power.Active.Import', unit: 'W' },
            { value: '1234500', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
          ],
        },
      ],
    });
    expect(readings[0].powerW).toBe(7360);
    expect(readings[0].energyWh).toBe(1234500);
  });

  it('treats a sample with no measurand as the energy register, per the spec', () => {
    // Easy to drop, and it shows up as a charger that reports power but never
    // accumulates any energy.
    const readings = parseMeterValues({
      meterValue: [{ sampledValue: [{ value: '9000', unit: 'Wh' }] }],
    });
    expect(readings[0].energyWh).toBe(9000);
  });

  it('sums per-phase power but lets a total win', () => {
    const perPhase = parseMeterValues({
      meterValue: [
        {
          sampledValue: [
            { value: '2000', measurand: 'Power.Active.Import', unit: 'W', phase: 'L1' },
            { value: '2000', measurand: 'Power.Active.Import', unit: 'W', phase: 'L2' },
            { value: '2000', measurand: 'Power.Active.Import', unit: 'W', phase: 'L3' },
          ],
        },
      ],
    });
    expect(perPhase[0].powerW).toBe(6000);

    const withTotal = parseMeterValues({
      meterValue: [
        {
          sampledValue: [
            { value: '2000', measurand: 'Power.Active.Import', unit: 'W', phase: 'L1' },
            { value: '7360', measurand: 'Power.Active.Import', unit: 'W' },
          ],
        },
      ],
    });
    expect(withTotal[0].powerW).toBe(7360);
  });

  it('reads state of charge when the car reports it', () => {
    const readings = parseMeterValues({
      meterValue: [{ sampledValue: [{ value: '54', measurand: 'SoC', unit: 'Percent' }] }],
    });
    expect(readings[0].soc).toBe(54);
  });

  it('survives junk without throwing', () => {
    expect(parseMeterValues({})).toEqual([]);
    expect(parseMeterValues({ meterValue: 'nope' })).toEqual([]);
    const odd = parseMeterValues({ meterValue: [{ sampledValue: [{ value: 'abc' }] }] });
    expect(odd[0].energyWh).toBeNull();
  });

  it('falls back to now for an unparseable timestamp rather than an invalid date', () => {
    const readings = parseMeterValues({
      meterValue: [{ timestamp: 'not-a-date', sampledValue: [] }],
    });
    expect(Number.isNaN(readings[0].at.getTime())).toBe(false);
  });
});

describe('connector status', () => {
  it('knows which statuses mean a car is plugged in', () => {
    for (const status of ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing']) {
      expect(statusMeansConnected(status), status).toBe(true);
    }
    for (const status of ['Available', 'Unavailable', 'Faulted', 'Reserved']) {
      expect(statusMeansConnected(status), status).toBe(false);
    }
    expect(statusMeansConnected(undefined)).toBe(false);
  });
});
