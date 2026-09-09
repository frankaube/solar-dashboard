import { Coordinates, HomeLocation, isAtHome } from './home-location';

/**
 * What to call the place a charge happened. TeslaMate's reverse-geocoded address parts
 * overlap — on many streets `name` and `road` hold the same value — and where home is
 * known, "Home" beats the street address.
 */

export interface AddressParts {
  name: string | null;
  road: string | null;
  city: string | null;
}

/**
 * Join the parts, dropping repeats. Case- and space-insensitive: "Bell Street" and
 * "bell street " are the same street.
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
 * "Home" when it was, the address when it was not, null when nothing is known. Falls
 * through to the address when home is unset or the charge has no position.
 */
export function chargePlace(
  position: Partial<Coordinates> | null,
  home: HomeLocation | null,
  address: AddressParts,
): string | null {
  return isAtHome(position, home) === true ? 'Home' : shortAddress(address);
}

/**
 * The two ends of a drive, with a city they share left off: naming it twice doubles the
 * label for no information, and the overflow truncates the destination away. Differing
 * cities are the point and stay.
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
