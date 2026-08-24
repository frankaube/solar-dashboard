/*
  Where the car is, drawn without asking anyone.

  A slippy map was already ruled out once in this app, for the radar, and every word of that
  reasoning applies harder here. A tile library means the browser talking to a third party on
  every drag — and where the radar would have leaked the household's rough position on page
  load, this would stream someone's live driving position to a tile server for the length of
  every journey. That is not a thing to add by accident.

  So the same answer: geography ships with the app. Natural Earth's coastlines, borders and
  lakes are already bundled for the radar, the projection is arithmetic, and nothing is
  fetched at runtime. It works on a machine with no internet.

  WHAT THIS CAN AND CANNOT SHOW

  Natural Earth 1:50m is regional: shorelines, provincial lines, big lakes. There are no
  roads in it and there is no way to fake them. A three-kilometre trip to the shops draws a
  squiggle in an empty box, and pretending otherwise would be worse than saying so.

  What it does show honestly is the shape of a journey, how far from home it has got, and in
  which direction — which is the question "where is the car" usually means. The scale bar is
  not decoration; without streets it is the only thing giving the shape a size.
*/

export interface TrackPoint {
  /** Epoch milliseconds. */
  at: number;
  lat: number;
  lon: number;
  /** km/h, or null where TeslaMate recorded none. */
  speedKmh: number | null;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Most points a track is drawn with.
 *
 * TeslaMate samples generously — a long motorway run is thousands of rows, and past a few
 * hundred they land inside the same pixel. Chosen for the drawing, not the database.
 */
export const MAX_TRACK_POINTS = 400;

/** Smallest window the map will show, in degrees — about 1 km. */
const MIN_SPAN_DEG = 0.01;
/** Breathing room around the track so it never touches the frame. */
const PADDING = 0.15;

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Thin a track to at most `limit` points, keeping the ends.
 *
 * Even sampling rather than anything cleverer: the shape of a drive at map scale survives it,
 * and a route-simplification algorithm would be a lot of code to make a line that looks the
 * same. The first and last points are always kept — the last one is where the car IS, which
 * is the entire point of the picture, and dropping it to satisfy a stride would be absurd.
 */
export function thin(points: TrackPoint[], limit = MAX_TRACK_POINTS): TrackPoint[] {
  if (points.length <= limit) return points;
  const stride = (points.length - 1) / (limit - 1);
  const out: TrackPoint[] = [];
  for (let i = 0; i < limit - 1; i++) out.push(points[Math.round(i * stride)]);
  out.push(points[points.length - 1]);
  return out;
}

/**
 * A square-ish window holding every point given.
 *
 * Square because the card is, and because a box fitted tightly to a north-south drive would
 * stretch the longitude scale until the track's shape was a lie. Home is passed in with the
 * track so a car that has just left is not drawn alone in a box with no reference in it.
 */
export function boxAround(points: Array<{ lat: number; lon: number }>): BoundingBox | null {
  if (!points.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;

  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  /*
    A degree of longitude is shorter than a degree of latitude everywhere but the equator, so
    a box equal in degrees is not square on the ground. Widening longitude by 1/cos(lat) makes
    the drawn shape match the drive — without it, a journey looks squashed east to west, and
    at this latitude that is a third of its width.
  */
  const shrink = Math.max(0.2, Math.cos(toRad(midLat)));
  const latSpan = Math.max(MIN_SPAN_DEG, maxLat - minLat);
  const lonSpan = Math.max(MIN_SPAN_DEG, (maxLon - minLon) * shrink);
  const half = (Math.max(latSpan, lonSpan) / 2) * (1 + PADDING);

  return {
    minLat: midLat - half,
    maxLat: midLat + half,
    minLon: midLon - half / shrink,
    maxLon: midLon + half / shrink,
  };
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Which way `to` lies from `from`, as a compass point.
 *
 * Eight points, not degrees. "27 km east" is a thing a person can picture; "27 km at 94°" is
 * a number they have to convert first.
 */
export function bearingFrom(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): (typeof COMPASS)[number] {
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLon);
  const deg = (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/**
 * A round number of kilometres to draw a scale bar with, and how wide it is as a fraction
 * of the box.
 *
 * Without streets the scale bar is the only thing that says whether this is a trip across
 * town or across the province, so it picks a 1/2/5 step rather than whatever a quarter of
 * the width happens to be — an unrounded bar is read as a measurement rather than a ruler.
 */
export function scaleBar(box: BoundingBox): { km: number; fraction: number } {
  const widthKm = distanceKm(
    { lat: (box.minLat + box.maxLat) / 2, lon: box.minLon },
    { lat: (box.minLat + box.maxLat) / 2, lon: box.maxLon },
  );
  if (!(widthKm > 0)) return { km: 0, fraction: 0 };
  const target = widthKm / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].find((s) => s * magnitude >= target) ?? 10;
  const km = step * magnitude;
  return { km, fraction: km / widthKm };
}
