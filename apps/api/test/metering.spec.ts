import { describe, expect, it } from 'vitest';
import { parseEventStream } from '../src/devices/esphome.adapter';
import {
  classifyEsphomeEntities,
  correctChannelEnergy,
  esphomeUnit,
  kasaHasEmeter,
  kwhToWh,
  normaliseKasaEmeter,
  pickShellyComponents,
  shellyChannels,
  shellyTotalEnergyWh,
  shellyTotalPowerW,
  shellyTotalReturnedWh,
  wattMinutesToWh,
} from '../src/devices/metering';

/**
 * These conversions are silent when wrong — a 60x energy error still plots as a
 * plausible curve — so they get the same treatment as the DTU scaling tests.
 */
describe('unit conversions', () => {
  it('converts Shelly Gen1 watt-minutes to watt-hours', () => {
    // The shipped adapter returned this raw, overstating energy by 60x.
    expect(wattMinutesToWh(6000)).toBe(100);
    expect(wattMinutesToWh(60)).toBe(1);
  });

  it('converts kWh to Wh', () => {
    expect(kwhToWh(1.5)).toBe(1500);
  });
});

describe('normaliseKasaEmeter', () => {
  it('reads newer firmware keys as real units', () => {
    const r = normaliseKasaEmeter({ power: 42.5, voltage: 121.3, current: 0.35, total: 12.5 });
    expect(r.powerW).toBeCloseTo(42.5, 3);
    expect(r.voltageV).toBeCloseTo(121.3, 3);
    expect(r.currentA).toBeCloseTo(0.35, 3);
    expect(r.energyWh).toBe(12500); // total is kWh
  });

  it('reads older firmware milli-units', () => {
    const r = normaliseKasaEmeter({
      power_mw: 42500,
      voltage_mv: 121300,
      current_ma: 350,
      total_wh: 12500,
    });
    expect(r.powerW).toBeCloseTo(42.5, 3);
    expect(r.voltageV).toBeCloseTo(121.3, 3);
    expect(r.currentA).toBeCloseTo(0.35, 3);
    // The trap: old `total_wh` is ALREADY watt-hours, unlike the other old keys
    // which are milli-units. Treating it as milli would give 12.5 Wh.
    expect(r.energyWh).toBe(12500);
  });

  it('is null-safe when the meter is absent', () => {
    const r = normaliseKasaEmeter(undefined);
    expect(r).toEqual({ powerW: null, energyWh: null, voltageV: null, currentA: null });
  });

  it('detects the energy-monitor capability from the feature string', () => {
    expect(kasaHasEmeter('TIM:ENE')).toBe(true);
    expect(kasaHasEmeter('TIM')).toBe(false);
    expect(kasaHasEmeter(undefined)).toBe(false);
    // Must not match a substring of another feature token.
    expect(kasaHasEmeter('TIM:ENERGYX')).toBe(false);
  });
});

describe('Shelly component discovery', () => {
  it('finds a plug switch channel', () => {
    const c = pickShellyComponents({ 'switch:0': { output: true, apower: 12.5 }, wifi: {} });
    expect(c).toHaveLength(1);
    expect(shellyTotalPowerW(c)).toBeCloseTo(12.5, 3);
  });

  it('sums the three channels of a split-phase / 3-phase energy meter', () => {
    // A Pro 3EM in monophase profile — previously reported null power entirely,
    // because only switch:0 / pm1:0 were read.
    const status = {
      'em1:0': { act_power: 400, total_act_energy: 1000 },
      'em1:1': { act_power: 350.5, total_act_energy: 900 },
      'em1:2': { act_power: -120, total_act_energy: 50 }, // exporting
      wifi: { rssi: -55 },
    };
    const c = pickShellyComponents(status);
    expect(c).toHaveLength(3);
    expect(shellyTotalPowerW(c)).toBeCloseTo(630.5, 3);
    expect(shellyTotalEnergyWh(c)).toBe(1950);
  });

  it('keeps negative power, because export is meaningful', () => {
    const c = pickShellyComponents({ 'em1:0': { act_power: -2400 } });
    expect(shellyTotalPowerW(c)).toBe(-2400);
  });

  it('prefers dedicated meter channels over a relay on the same device', () => {
    const c = pickShellyComponents({
      'switch:0': { output: true, apower: 5 },
      'pm1:0': { apower: 1234 },
    });
    expect(shellyTotalPowerW(c)).toBe(1234);
  });

  it('reads a metered dimmer, which lives under light:N', () => {
    const c = pickShellyComponents({ 'light:0': { output: true, apower: 8.25 } });
    expect(shellyTotalPowerW(c)).toBeCloseTo(8.25, 3);
  });

  it('returns null power when no channel reports it', () => {
    const c = pickShellyComponents({ 'switch:0': { output: true } });
    expect(shellyTotalPowerW(c)).toBeNull();
    expect(shellyTotalEnergyWh(c)).toBeNull();
  });

  it('ignores non-component keys', () => {
    expect(pickShellyComponents({ wifi: {}, sys: {}, cloud: {} })).toHaveLength(0);
  });
});

describe('multi-channel breakdown', () => {
  it('numbers legs from 1, leaving 0 for the device total', () => {
    const c = pickShellyComponents({
      'em1:0': { act_power: 400, total_act_energy: 1000, total_act_ret_energy: 10 },
      'em1:1': { act_power: -250, total_act_energy: 900, total_act_ret_energy: 640 },
    });
    const legs = shellyChannels(c);
    expect(legs.map((l) => l.channel)).toEqual([1, 2]);
    expect(legs[1].powerW).toBe(-250); // export preserved, not abs()'d
    expect(legs[1].energyReturnedWh).toBe(640);
  });

  it('returns no channels for single-channel hardware', () => {
    // Otherwise a plain plug would write a duplicate row identical to its own total.
    const c = pickShellyComponents({ 'switch:0': { output: true, apower: 12 } });
    expect(shellyChannels(c)).toEqual([]);
  });

  it('keeps returned energy separate from consumed', () => {
    const c = pickShellyComponents({
      'em1:0': { act_power: 100, total_act_energy: 5000, total_act_ret_energy: 1200 },
      'em1:1': { act_power: 50, total_act_energy: 3000, total_act_ret_energy: 800 },
    });
    expect(shellyTotalEnergyWh(c)).toBe(8000);
    expect(shellyTotalReturnedWh(c)).toBe(2000);
  });

  it('reports no returned energy when the meter does not count it', () => {
    const c = pickShellyComponents({ 'switch:0': { apower: 10, aenergy: { total: 42 } } });
    expect(shellyTotalReturnedWh(c)).toBeNull();
  });
});

/**
 * The 240 V correction is the silent-failure case par excellence: an uncorrected
 * mini split reads half its real draw and still plots a perfectly plausible curve,
 * all winter. Every load in this house that matters — mini splits, water heater,
 * baseboard, dryer — is two-pole, so the untested version of this is wrong about
 * nearly everything.
 */
describe('correctChannelEnergy', () => {
  const leg = (channel: number, drawnWh: number, multiplier = 1, returnedWh = 0) => ({
    channel,
    drawnWh,
    returnedWh,
    multiplier,
  });

  it('doubles a 240 V two-pole circuit clamped on one leg', () => {
    const [c] = correctChannelEnergy([leg(1, 2000, 2)], 2000);
    expect(c.drawnWh).toBe(4000);
  });

  it('leaves an ordinary 120 V circuit alone', () => {
    const [c] = correctChannelEnergy([leg(1, 2000)], 2000);
    expect(c.drawnWh).toBe(2000);
    expect(c.sharePct).toBe(100);
  });

  it('scales returned energy by the same factor', () => {
    // Export is halved by the same wiring, so correcting only consumption would
    // silently understate what a circuit sends back.
    const [c] = correctChannelEnergy([leg(1, 1000, 2, 300)], 1000);
    expect(c.returnedWh).toBe(600);
  });

  it('normalises share against the corrected sum, not the meter total', () => {
    // The bug this guards: the meter's own total is uncorrected, so dividing by it
    // would report a house of nothing but 240 V loads at ~200%.
    const out = correctChannelEnergy([leg(1, 3000, 2), leg(2, 1000, 2)], 4000);
    expect(out.map((c) => c.sharePct)).toEqual([75, 25]);
    expect(out.reduce((s, c) => s + c.sharePct, 0)).toBe(100);
  });

  it('keeps the device total as denominator when nothing is corrected', () => {
    // A meter's total channel can legitimately exceed the sum of its legs, so an
    // uncorrected breakdown should still be reported as a share of the real total.
    const out = correctChannelEnergy([leg(1, 2500), leg(2, 2500)], 10_000);
    expect(out.map((c) => c.sharePct)).toEqual([25, 25]);
  });

  it('ranks a mixed 120/240 panel by true consumption, not raw reading', () => {
    // Raw, the 120 V circuit looks bigger (1800 > 1500). Corrected, the mini split
    // is the larger load — which is the entire point of the feature.
    const out = correctChannelEnergy([leg(1, 1500, 2), leg(2, 1800)], 3300);
    const byChannel = Object.fromEntries(out.map((c) => [c.channel, c]));
    expect(byChannel[1].drawnWh).toBe(3000);
    expect(byChannel[2].drawnWh).toBe(1800);
    expect(byChannel[1].sharePct).toBeGreaterThan(byChannel[2].sharePct);
  });

  it('does not divide by zero when a meter reports nothing yet', () => {
    const out = correctChannelEnergy([leg(1, 0, 2)], 0);
    expect(out[0].sharePct).toBe(0);
    expect(Number.isFinite(out[0].sharePct)).toBe(true);
  });

  it('supports a three-phase leg', () => {
    expect(correctChannelEnergy([leg(1, 1000, 3)], 1000)[0].drawnWh).toBe(3000);
  });
});

describe('ESPHome event stream', () => {
  const frame = (obj: object) => `event: state\ndata: ${JSON.stringify(obj)}`;

  it('parses state frames into entities', () => {
    const out = parseEventStream(
      [
        frame({ id: 'sensor-input_power', name: 'Input power', state: '412 W', value: 412 }),
        frame({ id: 'switch-relay', name: 'Relay', state: 'ON', value: true }),
      ].join('\n\n'),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ domain: 'sensor', objectId: 'input_power', value: 412 });
    expect(out[1].on).toBe(true);
  });

  it('ignores log and ping frames', () => {
    const out = parseEventStream(
      ['event: ping\ndata: ', 'event: log\ndata: [I][app]: booted', frame({ id: 'sensor-x', value: 1 })].join(
        '\n\n',
      ),
    );
    expect(out.map((e) => e.id)).toEqual(['sensor-x']);
  });

  it('survives the truncated final frame the abort always produces', () => {
    // We cut the stream mid-flight by design, so the last frame is routinely
    // half-written. That must not lose the frames that already arrived.
    const out = parseEventStream(
      [frame({ id: 'sensor-a', value: 1 }), 'event: state\ndata: {"id":"sensor-b","val'].join('\n\n'),
    );
    expect(out.map((e) => e.id)).toEqual(['sensor-a']);
  });

  it('lets a later republish of the same entity win', () => {
    const out = parseEventStream(
      [frame({ id: 'sensor-a', value: 1 }), frame({ id: 'sensor-a', value: 2 })].join('\n\n'),
    );
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(2);
  });
});

/**
 * Unit-first classification. Entity names are author-chosen in YAML, so name-matching
 * would make this adapter quietly wrong on anyone else's device — and "quietly" is the
 * problem: a coil thermistor read as room temperature charts perfectly plausibly.
 */
describe('classifyEsphomeEntities', () => {
  const sensor = (objectId: string, name: string, state: string, value: number) => ({
    id: `sensor-${objectId}`,
    domain: 'sensor',
    objectId,
    name,
    state,
    value,
  });

  it('reads unit from the formatted state', () => {
    expect(esphomeUnit('412 W')).toBe('W');
    expect(esphomeUnit('-63.5 °C')).toBe('°C');
    expect(esphomeUnit('1234.5 kWh')).toBe('kWh');
    expect(esphomeUnit('ON')).toBeNull();
    expect(esphomeUnit(null)).toBeNull();
  });

  it('maps a Mitsubishi CN105 bridge onto the shared model', () => {
    const roles = classifyEsphomeEntities(
      [
        sensor('input_power', 'Input power', '412 W', 412),
        sensor('energy', 'Energy', '1234.5 kWh', 1234.5),
        sensor('room_temp', 'Room temperature', '21.4 °C', 21.4),
        sensor('outside_air', 'Outside air temperature', '-8.2 °C', -8.2),
        sensor('compressor', 'Compressor frequency', '42 Hz', 42),
        sensor('wifi', 'WiFi signal', '-55 dBm', -55),
      ],
      {},
    );
    expect(roles.powerW).toBe(412);
    expect(roles.energyWh).toBe(1_234_500);
    // The bug this guards: outdoor air is also °C, and on a January night
    // picking it would report the living room at -8.
    expect(roles.temperatureC).toBe(21.4);
    expect(roles.rssi).toBe(-55);
  });

  it('never mistakes a refrigeration probe for room temperature', () => {
    for (const name of ['Coil temperature', 'Discharge temp', 'Suction temp', 'Evaporator temp']) {
      const roles = classifyEsphomeEntities([sensor('t', name, '54.0 °C', 54)], {});
      expect(roles.temperatureC).toBeNull();
    }
  });

  it('prefers real power over apparent', () => {
    // VA overstates a nonlinear inverter load — the research put mini split power
    // factor near 0.53, so this is not a rounding difference.
    const roles = classifyEsphomeEntities(
      [
        sensor('apparent', 'Apparent power', '780 W', 780),
        sensor('power', 'Input power', '412 W', 412),
      ],
      {},
    );
    expect(roles.powerW).toBe(412);
  });

  it('prefers the lifetime counter over a daily one', () => {
    const roles = classifyEsphomeEntities(
      [
        sensor('today', 'Energy today', '3.2 kWh', 3.2),
        sensor('total', 'Energy', '1234.5 kWh', 1234.5),
      ],
      {},
    );
    expect(roles.energyWh).toBe(1_234_500);
  });

  it('scales kW and kWh to the shared W/Wh model', () => {
    const roles = classifyEsphomeEntities(
      [sensor('p', 'Power', '1.5 kW', 1.5), sensor('e', 'Energy', '2 kWh', 2)],
      {},
    );
    expect(roles.powerW).toBe(1500);
    expect(roles.energyWh).toBe(2000);
  });

  it('converts Fahrenheit, since ESPHome reports whatever the YAML declared', () => {
    const roles = classifyEsphomeEntities([sensor('t', 'Room temperature', '70 °F', 70)], {});
    expect(roles.temperatureC).toBeCloseTo(21.1, 1);
  });

  it('lets an explicit override win over every heuristic', () => {
    const roles = classifyEsphomeEntities(
      [sensor('a', 'Input power', '412 W', 412), sensor('b', 'Apparent power', '780 W', 780)],
      { powerW: 'sensor-b' },
    );
    expect(roles.powerW).toBe(780);
  });

  it('reports nulls rather than zeros when a device has no metering', () => {
    // A CN105 bridge on a North American MSZ is expected to publish no power at all;
    // that must read as "unknown", not as "the heat pump used nothing".
    const roles = classifyEsphomeEntities([sensor('f', 'Compressor frequency', '42 Hz', 42)], {});
    expect(roles).toEqual({ powerW: null, energyWh: null, temperatureC: null, rssi: null });
  });
});
