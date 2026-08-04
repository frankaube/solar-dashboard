import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RADIUS_M,
  distanceMeters,
  isAtHome,
  parseHome,
} from '../src/charger/home-location';

/*
  This exists so the Car page can say "at home" from a fact rather than the assumption it
  used to print. The tests that matter are the ones about not knowing: an unset home and a
  car that is elsewhere must never come out the same.
*/

/** Parliament Hill — a public landmark, so no fixture here is anybody's driveway. */
const HOME = { latitude: 45.4236, longitude: -75.7, radiusM: 100 };

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters(HOME, HOME)).toBe(0);
  });

  it('agrees with a known separation', () => {
    // One degree of latitude is ~111.2 km anywhere on earth — an independent check on the
    // formula, not a number read back out of it.
    const km = distanceMeters(
      { latitude: 46, longitude: -75.7000 },
      { latitude: 47, longitude: -75.7000 },
    ) / 1000;
    expect(km).toBeGreaterThan(111);
    expect(km).toBeLessThan(111.5);
  });

  it('shrinks longitude degrees with latitude', () => {
    // A degree of longitude is ~78 km at 45°N but ~111 km at the equator. A formula that
    // forgot the cos(lat) term would give the same answer for both.
    const atHome = distanceMeters({ latitude: 46, longitude: 0 }, { latitude: 46, longitude: 1 });
    const atEquator = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    expect(atHome).toBeLessThan(atEquator * 0.75);
  });

  it('survives antipodal rounding rather than returning NaN', () => {
    const d = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
    expect(Number.isFinite(d)).toBe(true);
  });
});

describe('isAtHome', () => {
  it('says yes inside the radius', () => {
    expect(isAtHome({ latitude: 45.4237, longitude: -75.7001 }, HOME)).toBe(true);
  });

  it('says no down the road', () => {
    // ~800 m away — the scale at which a car has genuinely left, not GPS drift.
    expect(isAtHome({ latitude: 45.43, longitude: -75.695 }, HOME)).toBe(false);
  });

  it('answers null when no home has been set', () => {
    /*
      Not false. "Nobody has told us where home is" is a setup state; "the car is
      elsewhere" is a fact about the car. The page renders them differently, and merging
      them is precisely the mistake that produced "Parked in the garage".
    */
    expect(isAtHome({ latitude: 45.4236, longitude: -75.7000 }, null)).toBeNull();
  });

  it('answers null when the car has no position', () => {
    expect(isAtHome(null, HOME)).toBeNull();
    expect(isAtHome({}, HOME)).toBeNull();
    expect(isAtHome({ latitude: 45.4236, longitude: undefined }, HOME)).toBeNull();
    expect(isAtHome({ latitude: Number.NaN, longitude: -75.7000 }, HOME)).toBeNull();
  });

  it('treats the radius as inclusive and honours a wider one', () => {
    const far = { latitude: 45.4300, longitude: -75.6950 };
    expect(isAtHome(far, HOME)).toBe(false);
    expect(isAtHome(far, { ...HOME, radiusM: 2000 })).toBe(true);
  });
});

describe('parseHome', () => {
  it('accepts what the form sends as strings', () => {
    const { home, problems } = parseHome({ latitude: '45.4236', longitude: '-75.7000', radiusM: '150' });
    expect(problems).toEqual([]);
    expect(home).toEqual({ latitude: 45.4236, longitude: -75.7000, radiusM: 150 });
  });

  it('defaults the radius rather than demanding one', () => {
    expect(parseHome({ latitude: 45.4236, longitude: -75.7000 }).home?.radiusM).toBe(DEFAULT_RADIUS_M);
  });

  it('refuses Null Island', () => {
    /*
      0,0 is what an empty form, a failed parse and a device that never got a fix all
      produce. Accepting it draws a circle in the Gulf of Guinea that the car is never
      inside — a home that silently never matches, which is worse than none.
    */
    const { home, problems } = parseHome({ latitude: 0, longitude: 0 });
    expect(home).toBeNull();
    expect(problems[0].message).toMatch(/0°, 0°/);
  });

  it('rejects coordinates off the globe', () => {
    expect(parseHome({ latitude: 91, longitude: 0 }).problems[0].field).toBe('latitude');
    expect(parseHome({ latitude: 46, longitude: 181 }).problems[0].field).toBe('longitude');
  });

  it('rejects a radius that is jitter or a county', () => {
    expect(parseHome({ latitude: 46, longitude: -75, radiusM: 5 }).problems[0].field).toBe('radiusM');
    expect(parseHome({ latitude: 46, longitude: -75, radiusM: 50_000 }).problems[0].field).toBe('radiusM');
  });

  it('reports a missing coordinate instead of inventing one', () => {
    const { home, problems } = parseHome({ longitude: -75.7000 });
    expect(home).toBeNull();
    expect(problems.map((p) => p.field)).toContain('latitude');
  });

  it('does not read an empty string as zero', () => {
    // Number('') is 0, which would put home in the Atlantic without anyone typing a digit.
    const { home, problems } = parseHome({ latitude: '', longitude: '' });
    expect(home).toBeNull();
    expect(problems.length).toBeGreaterThan(0);
  });
});
