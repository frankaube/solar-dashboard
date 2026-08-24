import { describe, expect, it } from 'vitest';
import { meterWatts, parsePowerwall } from '../src/battery/tesla-powerwall';
import { parseEnvoyStorage } from '../src/battery/enphase';
import { VICTRON_REGISTERS, parseVictronBattery } from '../src/battery/victron';
import { BATTERY_VENDORS, findBatteryVendor } from '../src/battery/vendors';

/**
 * Sign conventions are the trap shared by all of these.
 *
 * This app treats POSITIVE as charging. Tesla and Enphase both report the opposite,
 * Victron agrees with us. Getting one wrong shows a battery filling all evening and
 * draining all day — perfectly plausible on a chart, exactly backwards, and invisible
 * unless you already know the convention. These tests exist for that one bug.
 */
describe('Tesla Powerwall', () => {
  const soe = { percentage: 62.5 };

  it('inverts the sign: Tesla positive means discharging', () => {
    const discharging = parsePowerwall(soe, { battery: { instant_power: 2400 } });
    expect(discharging?.powerW).toBe(-2400);

    const charging = parsePowerwall(soe, { battery: { instant_power: -1800 } });
    expect(charging?.powerW).toBe(1800);
  });

  it('reads either firmware spelling of the power field', () => {
    // The field was renamed between releases and both are in the wild; picking one
    // and ignoring the other yields a confident 0 W instead of an error.
    expect(meterWatts({ instant_power: 500 })).toBe(500);
    expect(meterWatts({ real_power_w: 500 })).toBe(500);
    expect(meterWatts({})).toBeNull();
    expect(meterWatts(undefined)).toBeNull();
  });

  it('reads state of charge', () => {
    expect(parsePowerwall(soe, {})?.soc).toBe(62.5);
  });

  it('derives capacity from the nominal full pack, in kWh', () => {
    const reading = parsePowerwall(soe, {}, { nominal_full_pack_energy: 13500 });
    expect(reading?.capacityKwh).toBeCloseTo(13.5, 6);
  });

  it('leaves capacity unknown when the gateway does not report it', () => {
    expect(parsePowerwall(soe, {}, {})?.capacityKwh).toBeNull();
    expect(parsePowerwall(soe, {})?.capacityKwh).toBeNull();
  });

  it('returns null without a state of charge rather than inventing 0%', () => {
    expect(parsePowerwall({}, { battery: { instant_power: 100 } })).toBeNull();
    expect(parsePowerwall({ percentage: NaN }, {})).toBeNull();
  });

  it('treats a missing battery meter as zero flow, not as a failure', () => {
    expect(parsePowerwall(soe, {})?.powerW).toBe(0);
  });
});

describe('Enphase Envoy', () => {
  it('inverts the sign: Enphase positive means discharging', () => {
    const reading = parseEnvoyStorage({
      storage: [{ activeCount: 2, percentFull: 55, wNow: 1200, whNow: 5000 }],
    });
    expect(reading?.powerW).toBe(-1200);
  });

  it('ignores a storage entry with no active batteries', () => {
    /*
      A solar-only Envoy still returns the storage key — as one entry with
      activeCount 0. Treating "the key exists" as "there is a battery" would report a
      confident 0% for every solar-only system.
    */
    expect(parseEnvoyStorage({ storage: [{ activeCount: 0, percentFull: 0 }] })).toBeNull();
    expect(parseEnvoyStorage({ storage: [] })).toBeNull();
    expect(parseEnvoyStorage({})).toBeNull();
  });

  it('averages across battery groups', () => {
    const reading = parseEnvoyStorage({
      storage: [
        { activeCount: 1, percentFull: 40, wNow: 100, whNow: 1000 },
        { activeCount: 1, percentFull: 60, wNow: 100, whNow: 1000 },
      ],
    });
    expect(reading?.soc).toBe(50);
    expect(reading?.powerW).toBe(-200);
  });

  it('derives capacity from stored energy and fill level', () => {
    // 5000 Wh at 50% implies a 10 kWh pack.
    const reading = parseEnvoyStorage({
      storage: [{ activeCount: 1, percentFull: 50, wNow: 0, whNow: 5000 }],
    });
    expect(reading?.capacityKwh).toBeCloseTo(10, 1);
  });

  it('refuses to derive capacity from a nearly empty pack', () => {
    // Dividing by 1% turns a rounding error into a 500 kWh battery.
    const reading = parseEnvoyStorage({
      storage: [{ activeCount: 1, percentFull: 1, wNow: 0, whNow: 5000 }],
    });
    expect(reading?.capacityKwh).toBeNull();
  });
});

describe('Victron', () => {
  /** Four consecutive registers starting at 840: voltage, current, power, soc. */
  const registers = (voltage: number, current: number, power: number, soc: number): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeUInt16BE(voltage, 0);
    buf.writeInt16BE(current, 2);
    buf.writeInt16BE(power, 4);
    buf.writeUInt16BE(soc, 6);
    return buf;
  };

  it('keeps Victron’s sign, which already matches ours', () => {
    expect(parseVictronBattery(registers(480, 20, 2000, 75))?.powerW).toBe(2000);
  });

  it('reads discharge as signed, not as 63 kW', () => {
    /*
      -2000 read as unsigned is 63,536 W — a battery no house has, and a value that
      passes any check looking only for negative numbers.
    */
    expect(parseVictronBattery(registers(480, -20, -2000, 75))?.powerW).toBe(-2000);
  });

  it('reads state of charge', () => {
    expect(parseVictronBattery(registers(480, 0, 0, 42))?.soc).toBe(42);
  });

  it('reports the system voltage in the model name', () => {
    // 480 counts at 0.1 V is a 48 V system.
    expect(parseVictronBattery(registers(480, 0, 0, 50))?.model).toContain('48');
  });

  it('returns null on a short read rather than a wrong number', () => {
    expect(parseVictronBattery(Buffer.alloc(2))).toBeNull();
  });

  it('addresses the system service, not unit 1', () => {
    // Victron multiplexes services onto unit IDs; these registers on another unit
    // reach a different device and return plausible nonsense.
    expect(VICTRON_REGISTERS.soc).toBe(843);
    expect(VICTRON_REGISTERS.power).toBe(842);
  });
});

describe('the vendor registry', () => {
  it('offers every battery the page used to only promise', () => {
    const ids = BATTERY_VENDORS.map((v) => v.id);
    for (const expected of ['powerwall', 'victron', 'enphase', 'sunspec', 'ecoflow']) {
      expect(ids).toContain(expected);
    }
  });

  it('lists local options before the cloud one', () => {
    // The app's claim is that nothing leaves the house; a cloud vendor should read as
    // the compromise it is rather than the default.
    const firstCloud = BATTERY_VENDORS.findIndex((v) => v.connection === 'cloud');
    const lastLocal = BATTERY_VENDORS.map((v) => v.connection).lastIndexOf('local');
    expect(lastLocal).toBeLessThan(firstCloud);
  });

  it('builds nothing from an empty config, so a blank form cannot half-configure', () => {
    for (const vendor of BATTERY_VENDORS) {
      expect(vendor.createSource({}), vendor.id).toBeNull();
    }
  });

  it('builds a source once the required fields are there', () => {
    expect(findBatteryVendor('powerwall')!.createSource({ host: '10.0.0.5' })).not.toBeNull();
    expect(findBatteryVendor('victron')!.createSource({ host: '10.0.0.6' })).not.toBeNull();
    expect(findBatteryVendor('enphase')!.createSource({ host: '10.0.0.7' })).not.toBeNull();
    expect(findBatteryVendor('sunspec')!.createSource({ host: '10.0.0.8' })).not.toBeNull();
  });

  it('declares every vendor’s confidence, since none is verified on hardware', () => {
    for (const vendor of BATTERY_VENDORS) {
      expect(['verified', 'documented']).toContain(vendor.confidence);
    }
  });

  it('gives every field a label, since the UI renders them blind', () => {
    for (const vendor of BATTERY_VENDORS) {
      for (const field of vendor.fields) {
        expect(field.label, `${vendor.id}.${field.key}`).toBeTruthy();
      }
    }
  });
});
