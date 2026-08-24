/**
 * Where things are, parsed the same way wherever they are typed.
 *
 * There are two locations in this app — the array's, which drives the forecast, sunrise,
 * expected-vs-actual and the radar; and the car's home, which decides whether "parked" can
 * be called "parked at home". For almost every install they are the same patch of ground,
 * and the app used to hold them as two unrelated facts parsed by two different code paths
 * with two different sets of guards. One of those paths had a Null Island check and the
 * other did not, which is the whole reason this file exists.
 *
 * Nothing here touches the database. The readers below take the raw strings so the rules
 * can be tested without one.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export const SITE_SETTING_KEYS = {
  latitude: 'siteLatitude',
  longitude: 'siteLongitude',
} as const;

export const SITE_ENV_KEYS = {
  latitude: 'SITE_LATITUDE',
  longitude: 'SITE_LONGITUDE',
} as const;

/**
 * One coordinate, or null if there isn't one.
 *
 * The blank case is the point of this function. `Number('')` is `0`, and `0` is a perfectly
 * finite number, so a location that was never filled in used to resolve to a valid-looking
 * zero. The Pi installer writes `SITE_LATITUDE=` into .env with a comment saying that unset
 * means the feature stays off — but an empty environment variable is `''`, not `undefined`,
 * so every install made that way reported an array sitting at 0°, 0° and got a real forecast
 * for the Gulf of Guinea. Nothing errored; the numbers were just quietly about nowhere.
 */
export function parseCoordinate(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * 0°, 0° is in the Gulf of Guinea.
 *
 * It is what an empty form, a failed parse, and a device that has never had a GPS fix all
 * produce, and it passes every range check there is. Worth naming rather than folding into
 * the range test, because the two failures need different words: out-of-range is a typo,
 * and this is a value nobody entered.
 */
export function isNullIsland(latitude: number, longitude: number): boolean {
  return latitude === 0 && longitude === 0;
}

export const NULL_ISLAND_MESSAGE = 'That is 0°, 0° in the Atlantic — check the coordinates';

export interface CoordinateProblem {
  field: 'latitude' | 'longitude';
  message: string;
}

/** Whatever was typed or stored, as a pair of coordinates or as the reasons it is not one. */
export function parseCoordinates(
  latitudeInput: unknown,
  longitudeInput: unknown,
): { coordinates: Coordinates | null; problems: CoordinateProblem[] } {
  const problems: CoordinateProblem[] = [];
  const latitude = parseCoordinate(latitudeInput);
  const longitude = parseCoordinate(longitudeInput);

  if (latitude === null) problems.push({ field: 'latitude', message: 'Latitude is required' });
  else if (latitude < -90 || latitude > 90) {
    problems.push({ field: 'latitude', message: 'Latitude must be between -90 and 90' });
  }

  if (longitude === null) problems.push({ field: 'longitude', message: 'Longitude is required' });
  else if (longitude < -180 || longitude > 180) {
    problems.push({ field: 'longitude', message: 'Longitude must be between -180 and 180' });
  }

  if (latitude !== null && longitude !== null && isNullIsland(latitude, longitude)) {
    problems.push({ field: 'latitude', message: NULL_ISLAND_MESSAGE });
  }

  if (problems.length > 0 || latitude === null || longitude === null) {
    return { coordinates: null, problems };
  }
  return { coordinates: { latitude, longitude }, problems: [] };
}

/**
 * Where the array is, from the settings table with the environment behind it.
 *
 * Settings win so the UI can move the site without a restart; env exists so a container can
 * be seeded before anyone has clicked anything. Returns null rather than a guess — someone
 * else's forecast is worse than no forecast, because it looks like data.
 *
 * Takes readers rather than a Prisma client so that both the weather service and the vehicle
 * service can resolve this identically without either importing the other's module. They are
 * in separate Nest modules, and a shared service between them would be a circular dependency
 * that Nest reports as an undefined provider at boot — which takes down the whole API rather
 * than the feature that caused it.
 */
export function resolveSiteLocation(
  setting: (key: string) => string | undefined,
  env: Record<string, string | undefined> = process.env,
): Coordinates | null {
  const pick = (settingKey: string, envKey: string): unknown => {
    const stored = setting(settingKey);
    // Only fall through to env when the setting is genuinely absent — a row someone cleared
    // should not resurrect the value the installer seeded.
    return stored === undefined ? env[envKey] : stored;
  };
  const { coordinates } = parseCoordinates(
    pick(SITE_SETTING_KEYS.latitude, SITE_ENV_KEYS.latitude),
    pick(SITE_SETTING_KEYS.longitude, SITE_ENV_KEYS.longitude),
  );
  return coordinates;
}
