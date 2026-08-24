import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOUSE,
  annualConsumptionKwh,
  clearSkyKwh,
  dayLength,
  declination,
  noonElevation,
  peakSunHours,
  systemKw,
} from '../src/demo/house-spec';

const SUMMER_SOLSTICE = 172;
const WINTER_SOLSTICE = 355;
const EQUINOX = 81;

describe('solar geometry', () => {
  it('puts the sun where it belongs through the year', () => {
    expect(declination(EQUINOX)).toBeCloseTo(0, 1);
    expect(declination(SUMMER_SOLSTICE)).toBeCloseTo(23.4, 0);
    expect(declination(WINTER_SOLSTICE)).toBeCloseTo(-23.4, 0);
  });

  it('gives every latitude a 12-hour equinox', () => {
    for (const lat of [0, 25, 46.09, 60]) {
      expect(dayLength(lat, EQUINOX)).toBeCloseTo(12, 1);
    }
  });

  it('swings harder the further north you go', () => {
    const swing = (lat: number): number =>
      dayLength(lat, SUMMER_SOLSTICE) - dayLength(lat, WINTER_SOLSTICE);
    expect(swing(0)).toBeLessThan(0.5);
    expect(swing(46.09)).toBeGreaterThan(6);
    expect(swing(60)).toBeGreaterThan(swing(46.09));
  });

  it('survives the polar circles instead of returning NaN', () => {
    // acos() of an out-of-range ratio is NaN, which would poison every downstream
    // number silently. Above the Arctic circle the answers are 24 and 0.
    expect(dayLength(78, SUMMER_SOLSTICE)).toBe(24);
    expect(dayLength(78, WINTER_SOLSTICE)).toBe(0);
    expect(Number.isNaN(dayLength(90, WINTER_SOLSTICE))).toBe(false);
  });

  it('reports a polar night as no sun rather than negative sun', () => {
    expect(noonElevation(78, WINTER_SOLSTICE)).toBeLessThan(0);
    expect(peakSunHours(78, WINTER_SOLSTICE)).toBe(0);
  });
});

/**
 * The calibration claim, pinned. CLEARNESS was fitted so the model reproduces the two
 * constants the fixed demo hardcoded (135 kWh peak, 26 kWh trough for 24 kW at mid-
 * latitude). If someone retunes the constant, this is what tells them what they broke.
 *
 * The tolerances are wide enough to absorb the preset moving a degree or two of
 * latitude, which it has — they are checking the model against two remembered numbers,
 * not asserting a location.
 */
describe('calibration against the old fixed demo', () => {
  it('reproduces the summer peak within 10%', () => {
    const kwh = clearSkyKwh(DEFAULT_HOUSE, SUMMER_SOLSTICE);
    expect(kwh).toBeGreaterThan(135 * 0.9);
    expect(kwh).toBeLessThan(135 * 1.1);
  });

  it('reproduces the winter trough within 15%', () => {
    const kwh = clearSkyKwh(DEFAULT_HOUSE, WINTER_SOLSTICE);
    expect(kwh).toBeGreaterThan(26 * 0.85);
    expect(kwh).toBeLessThan(26 * 1.15);
  });

  it('still reads 24 kW installed', () => {
    expect(systemKw(DEFAULT_HOUSE)).toBe(24);
  });
});

describe('production across latitudes', () => {
  const summer = (lat: number): number => peakSunHours(lat, SUMMER_SOLSTICE);
  const winter = (lat: number): number => peakSunHours(lat, WINTER_SOLSTICE);

  it('keeps a sun-belt winter a large fraction of its summer', () => {
    // Phoenix. Pinned at the model's actual behaviour, not at reality: the real ratio
    // is nearer 0.55 and this reads ~0.38, because horizon elevation under-credits a
    // tilted array in winter. Documented as KNOWN BIAS on peakSunHours. The test
    // exists to catch drift, and to stop anyone reading 0.38 as a measurement.
    const ratio = winter(33.45) / summer(33.45);
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.45);
  });

  it('makes a northern winter almost worthless', () => {
    expect(winter(59.33) / summer(59.33)).toBeLessThan(0.12);
  });

  it('ranks summer output the way daylight does, not latitude', () => {
    // A long northern day beats a short equatorial one at the solstice — the model
    // must not simply decay with latitude.
    expect(summer(59.33)).toBeGreaterThan(summer(0));
  });

  it('never produces a negative or NaN yield anywhere on Earth, any day', () => {
    for (let lat = -90; lat <= 90; lat += 5) {
      for (let doy = 1; doy <= 365; doy += 7) {
        const psh = peakSunHours(lat, doy);
        expect(Number.isFinite(psh)).toBe(true);
        expect(psh).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('annualConsumptionKwh', () => {
  it('counts the EV and the heating choice', () => {
    const base = annualConsumptionKwh({ ...DEFAULT_HOUSE, heating: 'none', ev: null });
    const withHeatPump = annualConsumptionKwh({ ...DEFAULT_HOUSE, heating: 'heat-pump', ev: null });
    const withEv = annualConsumptionKwh({ ...DEFAULT_HOUSE, heating: 'none' });
    expect(withHeatPump).toBeGreaterThan(base);
    expect(withEv).toBeGreaterThan(base);
  });

  it('makes baseboard heating cost more than a heat pump', () => {
    const baseboard = annualConsumptionKwh({ ...DEFAULT_HOUSE, heating: 'baseboard' });
    const heatPump = annualConsumptionKwh({ ...DEFAULT_HOUSE, heating: 'heat-pump' });
    expect(baseboard).toBeGreaterThan(heatPump);
  });

  it('has no solar array contribute nothing to consumption', () => {
    // Guards a plausible mistake: consumption must not depend on the array.
    const withSolar = annualConsumptionKwh(DEFAULT_HOUSE);
    const withoutSolar = annualConsumptionKwh({ ...DEFAULT_HOUSE, solar: null });
    expect(withSolar).toBe(withoutSolar);
  });
});
