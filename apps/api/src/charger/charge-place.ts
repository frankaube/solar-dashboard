import { Coordinates, HomeLocation, isAtHome } from './home-location';

/**
 * What to call the place a charge happened.
 *
 * TeslaMate stores a reverse-geocoded address, and its parts overlap: on many streets
 * `name` and `road` hold the same value, so joining them produced "Bell Street, Bell
 * Street, Springfield" — a line that reads as a bug on every row of the list.
 *
 * And once the app knows where home is, the street address is the wrong answer anyway.
 * Nobody needs their own address recited back at them ten times down a page; they need to
 * know which charges were at home and which were not.
 */

export interface AddressParts {
  name: string | null;
  road: string | null;
  city: string | null;
}

/**
 * Join the parts, dropping repeats.
 *
 * Case- and space-insensitive, because "Bell Street" and "bell street " are the same
 * street and would otherwise both survive.
 */
export function shortAddress(parts: AddressParts): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [parts.name, parts.road, parts.city]) {
    const value = (part ?? '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length > 0 ? out.join(', ') : null;
}

/**
 * "Home" when it was, the address when it was not, null when nothing is known.
 *
 * Falls through to the address whenever home has not been set or the charge has no
 * position — an app that has not been told where home is must not start calling places
 * home, which is the mistake that had the Car page announcing a garage it knew nothing
 * about.
 */
export function chargePlace(
  position: Partial<Coordinates> | null,
  home: HomeLocation | null,
  address: AddressParts,
): string | null {
  return isAtHome(position, home) === true ? 'Home' : shortAddress(address);
}

/**
 * The two ends of a drive, with a city they share left off.
 *
 * "Ashley Crescent, Springfield → Route 15, Springfield" is fifty characters to
 * say two street names, and in a half-width card it truncated to "…→ H" — losing the
 * destination, which is the half people read. When both ends are in the same place, naming
 * it twice tells you nothing; when they are not, the city is the whole point and stays.
 */
export function routeLabels(
  from: { place: string | null; city: string | null },
  to: { place: string | null; city: string | null },
): { from: string | null; to: string | null } {
  const sameCity =
    Boolean(from.city) &&
    Boolean(to.city) &&
    from.city?.trim().toLowerCase() === to.city?.trim().toLowerCase();
  if (!sameCity) return { from: from.place, to: to.place };

  const strip = (label: string | null, city: string | null): string | null => {
    if (!label || !city) return label;
    // Only the trailing ", City" — a street genuinely named after the town keeps its name.
    const suffix = `, ${city}`;
    return label.toLowerCase().endsWith(suffix.toLowerCase())
      ? label.slice(0, -suffix.length)
      : label;
  };
  return { from: strip(from.place, from.city), to: strip(to.place, to.city) };
}
