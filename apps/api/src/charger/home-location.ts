/**
 * Where home is, so the car can be said to be at it.
 *
 * The Car page used to assert "Parked in the garage" with nothing behind it. Replacing a
 * guess with a fact needs someone to say which patch of the earth is home — TeslaMate has
 * a geofences table but it is empty on a fresh install, and writing into it would break the
 * one rule this integration keeps: TeslaMate owns its schema and we only SELECT.
 *
 * So the app stores its own, in its own settings.
 */

export const HOME_SETTING_KEYS = {
  latitude: 'homeLatitude',
  longitude: 'homeLongitude',
  radiusM: 'homeRadiusM',
} as const;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

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

/**
 * Turn whatever the form sent into a home, or say why it is not one.
 *
 * Takes unknown rather than a typed shape because it also parses values coming back out of
 * the settings table, where everything is a string.
 */
export function parseHome(input: {
  latitude?: unknown;
  longitude?: unknown;
  radiusM?: unknown;
}): { home: HomeLocation | null; problems: HomeProblem[] } {
  const problems: HomeProblem[] = [];
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const latitude = num(input.latitude);
  const longitude = num(input.longitude);
  const radius = num(input.radiusM);

  if (latitude === null) problems.push({ field: 'latitude', message: 'Latitude is required' });
  else if (latitude < -90 || latitude > 90) {
    problems.push({ field: 'latitude', message: 'Latitude must be between -90 and 90' });
  }

  if (longitude === null) problems.push({ field: 'longitude', message: 'Longitude is required' });
  else if (longitude < -180 || longitude > 180) {
    problems.push({ field: 'longitude', message: 'Longitude must be between -180 and 180' });
  }

  /*
    0,0 is in the Gulf of Guinea and is what an empty form, a failed parse or a device that
    has never had a fix all produce. Nobody lives there, and accepting it would draw a
    100 m circle round Null Island that the car is never in — a home that silently never
    matches is worse than no home at all.
  */
  if (latitude === 0 && longitude === 0) {
    problems.push({ field: 'latitude', message: 'That is 0°, 0° in the Atlantic — check the coordinates' });
  }

  const radiusM = radius === null ? DEFAULT_RADIUS_M : Math.round(radius);
  if (radius !== null && (radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M)) {
    problems.push({
      field: 'radiusM',
      message: `Radius must be between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} metres`,
    });
  }

  if (problems.length > 0 || latitude === null || longitude === null) {
    return { home: null, problems };
  }
  return { home: { latitude, longitude, radiusM }, problems: [] };
}
