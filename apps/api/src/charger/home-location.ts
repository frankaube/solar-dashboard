/**
 * Where home is, so the car can be said to be at it.
 *
 * The Car page used to assert "Parked in the garage" with nothing behind it. Replacing a
 * guess with a fact needs someone to say which patch of the earth is home — TeslaMate has
 * a geofences table but it is empty on a fresh install, and writing into it would break the
 * one rule this integration keeps: TeslaMate owns its schema and we only SELECT.
 *
 * So the app stores its own, in its own settings.
 *
 * Usually it stores the same place twice, which is what `mode` is about. The array has a
 * location too, and for all but the odd install — an array on a cottage, a car that lives
 * somewhere else — they are the same driveway. Following the site by default means there is
 * one place to correct it, and no way for the two to drift apart while both look set.
 */

import {
  Coordinates,
  NULL_ISLAND_MESSAGE,
  isNullIsland,
  parseCoordinate,
  parseCoordinates,
} from '../common/coordinates';

export type { Coordinates };

export const HOME_SETTING_KEYS = {
  latitude: 'homeLatitude',
  longitude: 'homeLongitude',
  radiusM: 'homeRadiusM',
  mode: 'homeLocationMode',
} as const;

/**
 * Whether home follows the array or stands on its own.
 *
 * `site` holds no coordinates of its own — it reads the site's every time, so moving the
 * site moves home with it. `manual` is for the install where they genuinely differ.
 */
export type HomeMode = 'site' | 'manual';

export const DEFAULT_MODE: HomeMode = 'site';

export interface HomeLocation extends Coordinates {
  /** How close counts. */
  radiusM: number;
}

/**
 * A driveway plus GPS drift.
 *
 * A car parked in a garage has no clear sky and can report a fix a good way off; 20 m —
 * TeslaMate's own default — would flicker between at-home and away while the car sat
 * still. 100 m is generous enough to stay steady and tight enough that the next street is
 * not home.
 */
export const DEFAULT_RADIUS_M = 100;

/** Below this a GPS fix cannot hold still; above it, "home" stops meaning a house. */
export const MIN_RADIUS_M = 20;
export const MAX_RADIUS_M = 2000;

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance. Haversine — accurate well past the scale of a neighbourhood. */
export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  // Clamped before the root: floating point can push h a hair over 1 for antipodal
  // points, and asin(>1) is NaN, which would silently read as "not at home".
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Is this position home?
 *
 * `null` — not false — when either side is unknown. "We have not been told where home is"
 * and "the car is somewhere else" are different answers, and only one of them should reach
 * a screen. Collapsing them is how the garage got there in the first place.
 */
export function isAtHome(
  position: Partial<Coordinates> | null | undefined,
  home: HomeLocation | null,
): boolean | null {
  if (!home) return null;
  if (
    !position ||
    typeof position.latitude !== 'number' ||
    typeof position.longitude !== 'number' ||
    !Number.isFinite(position.latitude) ||
    !Number.isFinite(position.longitude)
  ) {
    return null;
  }
  return distanceMeters({ latitude: position.latitude, longitude: position.longitude }, home) <= home.radiusM;
}

export interface HomeProblem {
  field: keyof typeof HOME_SETTING_KEYS;
  message: string;
}

/** Just the radius part, which belongs to the car in either mode. */
export function parseRadius(input: unknown): { radiusM: number; problems: HomeProblem[] } {
  const radius = parseCoordinate(input);
  const radiusM = radius === null ? DEFAULT_RADIUS_M : Math.round(radius);
  if (radius !== null && (radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M)) {
    return {
      radiusM: DEFAULT_RADIUS_M,
      problems: [
        {
          field: 'radiusM',
          message: `Radius must be between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} metres`,
        },
      ],
    };
  }
  return { radiusM, problems: [] };
}

/**
 * Turn whatever the form sent into a home, or say why it is not one.
 *
 * Takes unknown rather than a typed shape because it also parses values coming back out of
 * the settings table, where everything is a string.
 *
 * The coordinate rules — blanks, ranges, and the circle round Null Island that the car would
 * never be inside — are the site's rules too, and live in common/coordinates.
 */
export function parseHome(input: {
  latitude?: unknown;
  longitude?: unknown;
  radiusM?: unknown;
}): { home: HomeLocation | null; problems: HomeProblem[] } {
  const { coordinates, problems: coordinateProblems } = parseCoordinates(
    input.latitude,
    input.longitude,
  );
  const { radiusM, problems: radiusProblems } = parseRadius(input.radiusM);
  const problems: HomeProblem[] = [...coordinateProblems, ...radiusProblems];

  if (!coordinates || problems.length > 0) return { home: null, problems };
  return { home: { ...coordinates, radiusM }, problems: [] };
}

/**
 * Which mode an install is in, including the ones that predate the setting.
 *
 * An install that already had coordinates typed in keeps them: it was set up before there
 * was anything to follow, and silently repointing somebody's geofence at a site location
 * they have never seen is not an upgrade. Everything else follows the site, which is what a
 * fresh install should have done from the start.
 */
export function resolveMode(
  stored: string | undefined,
  hasManualCoordinates: boolean,
): HomeMode {
  if (stored === 'site' || stored === 'manual') return stored;
  return hasManualCoordinates ? 'manual' : DEFAULT_MODE;
}

export { NULL_ISLAND_MESSAGE, isNullIsland };
