import { describe, expect, it } from 'vitest';
import { chargePlace, routeLabels, shortAddress } from '../src/charger/charge-place';

const HOME = { latitude: 45.4236, longitude: -75.7, radiusM: 100 };
const AT_HOME = { latitude: 45.4237, longitude: -75.7001 };
const AWAY = { latitude: 45.5, longitude: -75.6 };

const STREET = { name: 'Bell Street', road: 'Bell Street', city: 'Springfield' };

describe('shortAddress', () => {
  it('drops a component that repeats another', () => {
    // TeslaMate fills name and road with the same street, giving
    // "Bell Street, Bell Street, Springfield".
    expect(shortAddress(STREET)).toBe('Bell Street, Springfield');
  });

  it('keeps genuinely different parts', () => {
    expect(shortAddress({ name: 'The Depot', road: 'Bell Street', city: 'Springfield' })).toBe(
      'The Depot, Bell Street, Springfield',
    );
  });

  it('ignores case and stray spacing when deciding what repeats', () => {
    expect(shortAddress({ name: 'bell street ', road: 'Bell Street', city: null })).toBe('bell street');
  });

  it('skips empty and missing parts rather than leaving stray commas', () => {
    expect(shortAddress({ name: '', road: 'Bell Street', city: null })).toBe('Bell Street');
    expect(shortAddress({ name: null, road: null, city: null })).toBeNull();
  });
});

describe('routeLabels', () => {
  it('drops a city both ends share', () => {
    // A city named at both ends truncates the destination away in a half-width card.
    const r = routeLabels(
      { place: 'Ashley Crescent, Springfield', city: 'Springfield' },
      { place: 'Route 15, Springfield', city: 'Springfield' },
    );
    expect(r).toEqual({ from: 'Ashley Crescent', to: 'Route 15' });
  });

  it('keeps the city when the ends differ', () => {
    const r = routeLabels(
      { place: 'Ashley Crescent, Springfield', city: 'Springfield' },
      { place: 'Dock Street, Shelbyville', city: 'Shelbyville' },
    );
    expect(r.to).toBe('Dock Street, Shelbyville');
  });

  it('leaves Home alone', () => {
    const r = routeLabels(
      { place: 'Home', city: 'Springfield' },
      { place: 'Route 15, Springfield', city: 'Springfield' },
    );
    expect(r.from).toBe('Home');
    expect(r.to).toBe('Route 15');
  });

  it('only strips a trailing city, not one inside the name', () => {
    // "Springfield Road, Springfield" keeps the street; only the suffix goes.
    const r = routeLabels(
      { place: 'Springfield Road, Springfield', city: 'Springfield' },
      { place: 'Dock Street, Springfield', city: 'Springfield' },
    );
    expect(r.from).toBe('Springfield Road');
  });

  it('copes with a missing end', () => {
    expect(routeLabels({ place: null, city: null }, { place: 'Home', city: null })).toEqual({
      from: null,
      to: 'Home',
    });
  });
});

describe('chargePlace', () => {
  it('says Home when the charge was at home', () => {
    expect(chargePlace(AT_HOME, HOME, STREET)).toBe('Home');
  });

  it('gives the address when it was somewhere else', () => {
    expect(chargePlace(AWAY, HOME, STREET)).toBe('Bell Street, Springfield');
  });

  it('gives the address when no home has been set', () => {
    // Not "Home": with no home configured, don't-know must not collapse into a claim.
    expect(chargePlace(AT_HOME, null, STREET)).toBe('Bell Street, Springfield');
  });

  it('gives the address when the charge has no position', () => {
    expect(chargePlace(null, HOME, STREET)).toBe('Bell Street, Springfield');
  });

  it('returns null when there is no address either', () => {
    expect(chargePlace(null, null, { name: null, road: null, city: null })).toBeNull();
  });
});
