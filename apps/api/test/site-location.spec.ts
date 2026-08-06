import { describe, expect, it } from 'vitest';
import {
  NULL_ISLAND_MESSAGE,
  parseCoordinate,
  parseCoordinates,
  resolveSiteLocation,
} from '../src/common/coordinates';
import { DEFAULT_MODE, resolveMode } from '../src/charger/home-location';

/*
  Where the array is — the setting the most figures depend on, and the one with no UI for the
  first year of this project's life.

  The bug these tests were written for shipped in the Pi installer and was silent by
  construction: it produced a valid coordinate for a place nobody lives, so every downstream
  feature carried on working and simply described the wrong hemisphere.
*/

/** Parliament Hill — a public landmark, so no fixture here is anybody's driveway. */
const SITE = { latitude: 45.4236, longitude: -75.7 };

describe('parseCoordinate', () => {
  it('does not read a blank as zero', () => {
    /*
      The whole bug in one assertion. `Number('')` is 0 and `Number.isFinite(0)` is true, so
      an unfilled coordinate used to arrive as a real location. The Pi installer wrote
      `SITE_LATITUDE=` into .env under a comment promising that unset meant the feature
      stayed off — but an empty environment variable is '', not undefined.
    */
    expect(parseCoordinate('')).toBeNull();
    expect(parseCoordinate('   ')).toBeNull();
    expect(parseCoordinate(undefined)).toBeNull();
    expect(parseCoordinate(null)).toBeNull();
  });

  it('still reads a real zero when someone means it', () => {
    // The equator is a place. Only the *pair* 0,0 is suspicious, and that is checked apart.
    expect(parseCoordinate(0)).toBe(0);
    expect(parseCoordinate('0')).toBe(0);
  });

  it('rejects what is not a number at all', () => {
    expect(parseCoordinate('north')).toBeNull();
    expect(parseCoordinate(Number.NaN)).toBeNull();
    expect(parseCoordinate(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('parseCoordinates', () => {
  it('refuses Null Island', () => {
    const { coordinates, problems } = parseCoordinates(0, 0);
    expect(coordinates).toBeNull();
    expect(problems.map((p) => p.message)).toContain(NULL_ISLAND_MESSAGE);
  });

  it('accepts a site on one axis of zero', () => {
    // Greenwich and the equator are both real. Only their intersection is the tell.
    expect(parseCoordinates(51.48, 0).coordinates).toEqual({ latitude: 51.48, longitude: 0 });
    expect(parseCoordinates(0, -78.5).coordinates).toEqual({ latitude: 0, longitude: -78.5 });
  });

  it('rejects coordinates off the globe', () => {
    expect(parseCoordinates(91, 0).problems[0].field).toBe('latitude');
    expect(parseCoordinates(45, 181).problems[0].field).toBe('longitude');
  });
});

describe('resolveSiteLocation', () => {
  const none = (): undefined => undefined;

  it('is null when nothing has been set', () => {
    expect(resolveSiteLocation(none, {})).toBeNull();
  });

  it('is null when the installer seeded blank keys', () => {
    /*
      The shipped case. Before this, it returned {0, 0} — and the forecast, sunrise, sunset,
      expected-vs-actual, cloud panel and radar all quietly described the Gulf of Guinea. A
      12-hour August day at 46°N is wrong by three hours, and nothing said so.
    */
    expect(resolveSiteLocation(none, { SITE_LATITUDE: '', SITE_LONGITUDE: '' })).toBeNull();
  });

  it('uses the environment when it holds a real place', () => {
    const site = resolveSiteLocation(none, { SITE_LATITUDE: '45.4236', SITE_LONGITUDE: '-75.7' });
    expect(site).toEqual(SITE);
  });

  it('lets a setting win over the environment, so the UI needs no restart', () => {
    const stored: Record<string, string> = { siteLatitude: '46.5', siteLongitude: '-66.5' };
    const site = resolveSiteLocation(
      (key) => stored[key],
      { SITE_LATITUDE: '45.4236', SITE_LONGITUDE: '-75.7' },
    );
    expect(site).toEqual({ latitude: 46.5, longitude: -66.5 });
  });

  it('does not resurrect the seeded env when a setting was cleared to blank', () => {
    // A row that exists and is empty is somebody having removed the value. Falling through
    // to env there would put the location back without anyone asking.
    const stored: Record<string, string> = { siteLatitude: '', siteLongitude: '' };
    const site = resolveSiteLocation(
      (key) => stored[key],
      { SITE_LATITUDE: '45.4236', SITE_LONGITUDE: '-75.7' },
    );
    expect(site).toBeNull();
  });

  it('refuses a stored Null Island rather than passing it upstream', () => {
    const stored: Record<string, string> = { siteLatitude: '0', siteLongitude: '0' };
    expect(resolveSiteLocation((key) => stored[key], {})).toBeNull();
  });
});

describe('resolveMode', () => {
  it('follows the site on a fresh install', () => {
    expect(resolveMode(undefined, false)).toBe('site');
    expect(DEFAULT_MODE).toBe('site');
  });

  it('leaves an install that already typed coordinates alone', () => {
    /*
      These were set before there was a site to follow. Silently repointing somebody's
      geofence at a location they have never seen is not an upgrade — and if the site is
      unset, it would quietly turn a working "at home" into "unknown".
    */
    expect(resolveMode(undefined, true)).toBe('manual');
  });

  it('honours an explicit choice either way', () => {
    expect(resolveMode('site', true)).toBe('site');
    expect(resolveMode('manual', false)).toBe('manual');
  });

  it('falls back rather than trusting a hand-edited row', () => {
    expect(resolveMode('SITE', false)).toBe('site');
    expect(resolveMode('whatever', true)).toBe('manual');
  });
});
