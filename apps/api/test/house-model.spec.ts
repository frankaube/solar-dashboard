import { describe, expect, it } from 'vitest';
import { annualFlows, compareHouses, valueHouse } from '../src/demo/house-model';
import { BATTERY_OPTIONS, DEFAULT_HOUSE, EV_OPTIONS, HouseSpec } from '../src/demo/house-spec';

const noBattery: HouseSpec = { ...DEFAULT_HOUSE, battery: null };
const withBattery: HouseSpec = { ...DEFAULT_HOUSE, battery: BATTERY_OPTIONS[4] };

describe('annualFlows', () => {
  it('conserves energy: production splits into self-consumed and exported', () => {
    const f = annualFlows(withBattery);
    expect(f.selfConsumedKwh + f.exportedKwh).toBeCloseTo(f.producedKwh, 5);
  });

  it('conserves the other side too: consumption splits into self-consumed and imported', () => {
    const f = annualFlows(withBattery);
    expect(f.selfConsumedKwh + f.importedKwh).toBeCloseTo(f.consumedKwh, 5);
  });

  it('never self-consumes more than it makes or more than it needs', () => {
    for (const spec of [noBattery, withBattery, { ...DEFAULT_HOUSE, heating: 'none' as const }]) {
      const f = annualFlows(spec);
      expect(f.selfConsumedKwh).toBeLessThanOrEqual(f.producedKwh + 1e-6);
      expect(f.selfConsumedKwh).toBeLessThanOrEqual(f.consumedKwh + 1e-6);
    }
  });

  it('a battery raises self-consumption', () => {
    expect(annualFlows(withBattery).selfConsumptionPct).toBeGreaterThan(
      annualFlows(noBattery).selfConsumptionPct,
    );
  });

  it('never reaches 100% self-consumption, however oversized the battery', () => {
    // The Stockholm preset used to read exactly 100%, which is not a thing that
    // happens to anyone who owns a battery.
    const northern: HouseSpec = {
      ...DEFAULT_HOUSE,
      solar: { panelCount: 8, panelWatts: 400 },
      battery: { label: 'absurd', capacityKwh: 200, usableFraction: 1 },
      heating: 'baseboard',
    };
    expect(annualFlows(northern).selfConsumptionPct).toBeLessThan(100);
    expect(annualFlows(northern).exportedKwh).toBeGreaterThan(0);
  });

  it('handles a house with no solar at all', () => {
    const f = annualFlows({ ...DEFAULT_HOUSE, solar: null });
    expect(f.producedKwh).toBe(0);
    expect(f.selfConsumptionPct).toBe(0);
    expect(f.importedKwh).toBe(f.consumedKwh);
  });
});

/**
 * The comparison is the product. These pin the cases where the honest answer is
 * "this does nothing for you" — a model that always recommends the upgrade is an
 * advert, not a decision aid.
 */
describe('compareHouses', () => {
  it('values a battery on a house that has surplus to store', () => {
    const c = compareHouses(noBattery, withBattery);
    expect(c.realisedDeltaPerYear).toBeGreaterThan(0);
    expect(c.selfConsumptionDeltaPct).toBeGreaterThan(0);
    expect(c.producedDeltaKwh).toBeCloseTo(0, 5); // a battery makes no energy
  });

  it('gives a battery almost nothing when there is no load to shift it into', () => {
    // Tiny array, no EV, no heating: barely any surplus and barely any evening load.
    const bare: HouseSpec = {
      ...DEFAULT_HOUSE,
      solar: { panelCount: 4, panelWatts: 400 },
      ev: null,
      heating: 'none',
      battery: null,
    };
    const c = compareHouses(bare, { ...bare, battery: BATTERY_OPTIONS[4] });
    const asShareOfBill = c.realisedDeltaPerYear / c.before.billWithoutSolarPerYear;
    expect(asShareOfBill).toBeLessThan(0.1);
  });

  it('reports payback as null rather than Infinity when nothing is gained', () => {
    const bare: HouseSpec = { ...DEFAULT_HOUSE, solar: null, battery: null };
    const c = compareHouses(bare, { ...bare, battery: BATTERY_OPTIONS[4] }, 12000);
    expect(c.paybackYears).toBeNull();
  });

  it('computes payback from the gain, not from the headline', () => {
    const c = compareHouses(noBattery, withBattery, 12000);
    expect(c.paybackYears).not.toBeNull();
    expect(c.paybackYears).toBeCloseTo(12000 / c.realisedDeltaPerYear, 6);
  });

  it('values adding panels as more production', () => {
    const bigger: HouseSpec = { ...noBattery, solar: { panelCount: 96, panelWatts: 500 } };
    const c = compareHouses(noBattery, bigger);
    expect(c.producedDeltaKwh).toBeGreaterThan(0);
    expect(c.realisedDeltaPerYear).toBeGreaterThan(0);
  });

  it('shows an EV raising self-consumption without adding production', () => {
    const withEv = { ...noBattery, ev: EV_OPTIONS[2] };
    const c = compareHouses({ ...noBattery, ev: null }, withEv);
    expect(c.producedDeltaKwh).toBeCloseTo(0, 5);
    expect(c.selfConsumptionDeltaPct).toBeGreaterThan(0);
  });
});

describe('valueHouse', () => {
  it('routes through the reward engine and produces itemised lines', () => {
    // The point of wiring this up: the answer is explained, not just asserted.
    const v = valueHouse(withBattery);
    expect(v.valuation.lines.length).toBeGreaterThan(0);
    expect(v.valuation.realised).toBeGreaterThan(0);
    expect(v.valuation.ceiling).toBeGreaterThanOrEqual(v.valuation.realised);
  });

  it('never shows a negative bill', () => {
    const huge: HouseSpec = { ...DEFAULT_HOUSE, solar: { panelCount: 400, panelWatts: 500 } };
    expect(valueHouse(huge).billWithSolarPerYear).toBeGreaterThanOrEqual(0);
  });

  it('values the same house differently under a different programme', () => {
    // The whole claim of the reward engine, exercised end to end.
    const netMetering = valueHouse(withBattery);
    const fit = valueHouse({
      ...withBattery,
      tariff: { ...withBattery.tariff, programId: 'feed-in-tariff' },
    });
    expect(fit.valuation.realised).not.toBeCloseTo(netMetering.valuation.realised, 2);
  });
});
