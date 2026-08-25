/**
 * The array's location and the car's home must apply the same guards, Null Island included.
 * Nothing here touches the database — the readers below take raw strings.
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
 * `Number('')` is a finite `0`, so a location never filled in resolves to a valid-looking
 * zero — and the Pi installer's `SITE_LATITUDE=` arrives as `''`, not `undefined`.
 */
export function parseCoordinate(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * 0°, 0° is in the Gulf of Guinea: what an empty form, a failed parse and a device with no
 * GPS fix all produce, and it passes every range check. Its own message: nobody entered it.
 */
export function isNullIsland(latitude: number, longitude: number): boolean {
  return latitude === 0 && longitude === 0;
}

export const NULL_ISLAND_MESSAGE = 'That is 0°, 0° in the Atlantic — check the coordinates';

export interface CoordinateProblem {
  field: 'latitude' | 'longitude';
  message: string;
}

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
 * Settings win over env so the UI can move the site without a restart. Takes readers rather
 * than a Prisma client so the weather and vehicle services resolve this without importing
 * each other — a shared service is a circular dependency Nest reports as undefined at boot.
 */
export function resolveSiteLocation(
  setting: (key: string) => string | undefined,
  env: Record<string, string | undefined> = process.env,
): Coordinates | null {
  const pick = (settingKey: string, envKey: string): unknown => {
    const stored = setting(settingKey);
    // Only fall through when the setting is absent: a cleared row must not resurrect env.
    return stored === undefined ? env[envKey] : stored;
  };
  const { coordinates } = parseCoordinates(
    pick(SITE_SETTING_KEYS.latitude, SITE_ENV_KEYS.latitude),
    pick(SITE_SETTING_KEYS.longitude, SITE_ENV_KEYS.longitude),
  );
  return coordinates;
}
