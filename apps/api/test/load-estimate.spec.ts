import { describe, expect, it } from 'vitest';
import { estimateFromOnTime, readLoadConfig } from '../src/devices/load-estimate';

/**
 * The arithmetic is one multiplication; what varies is how much trust it deserves for a
 * given load type, and the app has to declare that.
 */
describe('estimateFromOnTime', () => {
  it('turns on-time into energy', () => {
    // 1100 W pool pump running 8 h = 8.8 kWh.
    const e = estimateFromOnTime(8, { ratedW: 1100, loadType: 'motor' })!;
    expect(e.energyWh).toBeCloseTo(8800, 6);
  });

  it('trusts a resistive load', () => {
    // A heater draws its rated wattage whenever the relay is closed; no modulation.
    expect(estimateFromOnTime(3, { ratedW: 1500, loadType: 'resistive' })!.confidence).toBe('good');
  });

  it('trusts a single-speed motor', () => {
    expect(estimateFromOnTime(3, { ratedW: 1100, loadType: 'motor' })!.confidence).toBe('good');
  });

  it('is honest that a variable-speed load is barely an estimate', () => {
    // Inverter-driven equipment spans several to one, so on-time x rated is an upper
    // bound, not a measurement.
    const e = estimateFromOnTime(8, { ratedW: 1100, loadType: 'variable' })!;
    expect(e.confidence).toBe('rough');
    expect(e.note).toContain('ceiling');
  });

  it('does not silently scale the number to match its confidence', () => {
    // Confidence changes the wording, never the arithmetic.
    const good = estimateFromOnTime(10, { ratedW: 1000, loadType: 'resistive' })!;
    const rough = estimateFromOnTime(10, { ratedW: 1000, loadType: 'variable' })!;
    expect(good.energyWh).toBe(rough.energyWh);
  });

  it('assumes the least flattering case when no type is declared', () => {
    const e = estimateFromOnTime(5, { ratedW: 500 })!;
    expect(e.confidence).toBe('rough');
    expect(e.note).toContain('No load type set');
  });

  it('returns null rather than zero when there is nothing to go on', () => {
    // An unmetered device with no declared wattage has unknown consumption, which must
    // not render as 0.0 kWh.
    expect(estimateFromOnTime(10, {})).toBeNull();
    expect(estimateFromOnTime(10, { ratedW: 0 })).toBeNull();
    expect(estimateFromOnTime(10, { ratedW: -50 })).toBeNull();
    expect(estimateFromOnTime(10, { ratedW: NaN })).toBeNull();
  });

  it('is zero energy, not null, for a device that never came on', () => {
    // Distinct from the case above: the wattage is known and the on-time is zero.
    expect(estimateFromOnTime(0, { ratedW: 1100, loadType: 'motor' })!.energyWh).toBe(0);
  });

  it('rejects nonsensical on-time', () => {
    expect(estimateFromOnTime(-1, { ratedW: 100 })).toBeNull();
    expect(estimateFromOnTime(Infinity, { ratedW: 100 })).toBeNull();
  });

  it('carries the owner’s label through', () => {
    expect(estimateFromOnTime(1, { ratedW: 100, loadLabel: 'Pool pump' })!.label).toBe('Pool pump');
  });
});

describe('readLoadConfig', () => {
  it('reads a full config', () => {
    expect(readLoadConfig('{"ratedW":1100,"loadLabel":"Pool pump","loadType":"motor"}')).toEqual({
      ratedW: 1100,
      loadLabel: 'Pool pump',
      loadType: 'motor',
    });
  });

  it('ignores an unknown load type rather than trusting it', () => {
    expect(readLoadConfig('{"ratedW":100,"loadType":"nuclear"}').loadType).toBeUndefined();
  });

  it('survives config that is not load settings at all', () => {
    // The same JSON blob holds HomeKit pairing data and channel labels.
    expect(readLoadConfig('{"pairingData":{"x":1},"gen":2}')).toEqual({});
  });

  it('survives unparseable config', () => {
    expect(readLoadConfig('not json')).toEqual({});
    expect(readLoadConfig(null)).toEqual({});
  });

  it('drops a blank label rather than storing whitespace', () => {
    expect(readLoadConfig('{"loadLabel":"   "}').loadLabel).toBeUndefined();
  });
});
