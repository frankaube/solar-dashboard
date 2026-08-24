import { describe, expect, it } from 'vitest';
import { DemoHouse } from '../src/demo/demo.service';
import { BATTERY_OPTIONS, DEFAULT_HOUSE, EV_OPTIONS, HouseSpec } from '../src/demo/house-spec';

const bare: HouseSpec = {
  ...DEFAULT_HOUSE,
  label: 'bare',
  solar: { panelCount: 10, panelWatts: 400 },
  battery: null,
  ev: null,
  heating: 'none',
};

/**
 * These cases were unreachable until the demo became configurable: every generated
 * house had a Powerwall and an EV by construction, so nothing ever asked what the
 * endpoints should say when it does not.
 */
describe('a house with no battery', () => {
  it('reports the battery as absent rather than as an empty one', () => {
    // `present: true, capacityKwh: 0` is what fell out of the refactor first — the
    // Battery page would have drawn a pack cycling charge it does not have.
    expect(new DemoHouse(bare).battery()).toEqual({ present: false });
  });

  it('still reports one when the spec has it', () => {
    const withBattery = new DemoHouse({ ...bare, battery: BATTERY_OPTIONS[4] }).battery() as {
      present: boolean;
      capacityKwh: number;
      name: string;
    };
    expect(withBattery.present).toBe(true);
    expect(withBattery.capacityKwh).toBe(13.5);
  });

  it('names the battery from the spec instead of always saying Powerwall', () => {
    const ecoflow = new DemoHouse({ ...bare, battery: BATTERY_OPTIONS[1] }).battery() as {
      name: string;
    };
    expect(ecoflow.name).toContain('EcoFlow');
  });
});

describe('a house with no EV', () => {
  it('does not show a car charging', () => {
    expect(new DemoHouse(bare).charger()).toEqual({ live: null, vehicle: null });
  });

  it('shows one when the spec has it', () => {
    const charger = new DemoHouse({ ...bare, ev: EV_OPTIONS[1] }).charger() as { live: object };
    expect(charger.live).not.toBeNull();
  });
});

describe('the spec drives the generated dataset', () => {
  it('reports the array it was given', () => {
    const summary = new DemoHouse(bare).summary() as { ratedKw: number; panelsTotal: number };
    expect(summary.ratedKw).toBe(4);
    expect(summary.panelsTotal).toBe(10);
  });

  it('carries the tariff through to config', () => {
    const spec: HouseSpec = {
      ...bare,
      tariff: { retailPerKwh: 0.31, taxRate: 0.2, programId: 'net-metering' },
    };
    const config = new DemoHouse(spec).config() as {
      electricityPricePerKwh: number;
      hstRate: number;
    };
    expect(config.electricityPricePerKwh).toBe(0.31);
    expect(config.hstRate).toBe(0.2);
  });

  it('makes a sunnier house out-produce a darker one with the same array', () => {
    const kwh = (latitude: number): number =>
      (
        new DemoHouse({
          ...bare,
          location: { label: 'x', latitude, timezone: 'UTC' },
        }).stats() as { yearWh: number }
      ).yearWh;
    expect(kwh(33.45)).toBeGreaterThan(kwh(59.33));
  });

  it('produces nothing at all with no array, without dividing by zero', () => {
    const none = new DemoHouse({ ...bare, solar: null });
    const stats = none.stats() as { yearWh: number; lifetimeWh: number };
    expect(stats.yearWh).toBe(0);
    expect(Number.isFinite(stats.lifetimeWh)).toBe(true);
  });

  it('survives a polar latitude, where the old duplicated maths returned NaN', () => {
    const arctic = new DemoHouse({
      ...bare,
      location: { label: 'Svalbard', latitude: 78, timezone: 'UTC' },
    });
    const stats = arctic.stats() as { yearWh: number };
    expect(Number.isFinite(stats.yearWh)).toBe(true);
    expect(stats.yearWh).toBeGreaterThanOrEqual(0);
  });
});
