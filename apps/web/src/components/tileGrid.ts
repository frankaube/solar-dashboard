/*
  Which street tiles cover a lat/lon window, and where each one sits in the picture.

  Slippy-map tiles are a Web Mercator pyramid: at zoom z the world is a 2^z square of 256 px
  images. The car map's window is a plain lat/lon box, so this converts one to the other and
  hands back the tiles plus their placement as percentages of the box.

  Mercator is the reason this needs care. Longitude maps linearly, latitude does not — it
  goes through a log-tangent, and treating it as linear puts every tile a little further out
  of place the further the map is from the equator. At 46 north that error is visible: the
  streets would sit beside the track rather than under it.
*/

export interface Tile {
  z: number;
  x: number;
  y: number;
  /** Placement in the containing box, as percentages. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LatLonBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Tiles asked for at once, before the zoom steps out instead.
 *
 * Generous because they are cached on disk forever and streets do not move: the ceiling is
 * paid once per area ever, and the tiles around home are paid on the first trip. Kept low it
 * cost a whole zoom level of detail — which is the thing the tiles were added for.
 */
const MAX_TILES = 72;
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;

/** Web Mercator, in tile units at the given zoom. */
export function tileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

/**
 * Web Mercator is only defined to about 85.05 degrees, which is where the projection's
 * square meets the poles — and it is exactly the range OSM publishes tiles for.
 *
 * Clamping nearer the pole than this does not buy coverage, it loses precision: at 90
 * degrees tan and sec are both about 1e9 with opposite signs, they cancel to zero, and the
 * log of that is -Infinity. A tile index of NaN places an image nowhere.
 */
const MERCATOR_LIMIT_DEG = 85.05112878;

export function tileY(lat: number, z: number): number {
  const clampedDeg = Math.max(-MERCATOR_LIMIT_DEG, Math.min(MERCATOR_LIMIT_DEG, lat));
  const rad = (clampedDeg * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

/** Inverse of tileY — a tile edge back to a latitude, for placing the image. */
export function latOfTileY(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * The deepest zoom whose tiles still cover this box within the budget.
 *
 * Deepest rather than nearest, because detail is the whole reason the tiles are here — but
 * bounded, since a tight box at zoom 18 is a hundred requests for a card the size of a
 * postcard.
 */
export function zoomFor(box: LatLonBox, maxTiles = MAX_TILES): number {
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const across = Math.floor(tileX(box.maxLon, z)) - Math.floor(tileX(box.minLon, z)) + 1;
    const down = Math.floor(tileY(box.minLat, z)) - Math.floor(tileY(box.maxLat, z)) + 1;
    if (across * down <= maxTiles) return z;
  }
  return MIN_ZOOM;
}

/**
 * Every tile covering the box, placed as percentages of it.
 *
 * Percentages rather than pixels so the caller can size the map however it likes and the
 * streets stay registered to the track drawn over them.
 */
export function tilesFor(box: LatLonBox, maxTiles = MAX_TILES): Tile[] {
  const z = zoomFor(box, maxTiles);
  const x0 = Math.floor(tileX(box.minLon, z));
  const x1 = Math.floor(tileX(box.maxLon, z));
  const y0 = Math.floor(tileY(box.maxLat, z));
  const y1 = Math.floor(tileY(box.minLat, z));

  const lonSpan = box.maxLon - box.minLon;
  // The box's own edges in Mercator units, which the tiles are positioned against.
  const yTop = tileY(box.maxLat, z);
  const ySpan = tileY(box.minLat, z) - yTop;
  if (!(lonSpan > 0) || !(ySpan > 0)) return [];

  const tiles: Tile[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const lonLeft = (x / 2 ** z) * 360 - 180;
      const lonRight = ((x + 1) / 2 ** z) * 360 - 180;
      tiles.push({
        z,
        x,
        y,
        left: ((lonLeft - box.minLon) / lonSpan) * 100,
        width: ((lonRight - lonLeft) / lonSpan) * 100,
        top: ((y - yTop) / ySpan) * 100,
        height: (1 / ySpan) * 100,
      });
    }
  }
  return tiles;
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A round distance to draw a scale bar with, and how wide it is as a fraction of the box.
 *
 * Computed here rather than taken from the server because the drawn window is not the one
 * the server framed — it is widened to the card, and it changes again when the view is
 * pulled in around the car. A bar measured against a different box is worse than no bar.
 *
 * The 1/2/5 step matters: an unrounded bar reads as a measurement of something rather than
 * as a ruler.
 */
export function scaleFor(box: LatLonBox): { km: number; fraction: number } {
  const midLat = (box.minLat + box.maxLat) / 2;
  const widthKm = distanceKm({ lat: midLat, lon: box.minLon }, { lat: midLat, lon: box.maxLon });
  if (!(widthKm > 0)) return { km: 0, fraction: 0 };
  const target = widthKm / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].find((s) => s * magnitude >= target) ?? 10;
  const km = step * magnitude;
  return { km, fraction: km / widthKm };
}

/**
 * A window of roughly `acrossKm` centred on one point.
 *
 * What "zoom to surroundings" means. Framing the whole journey answers "where has it been";
 * this answers "where is it now", which at a 29 km span no amount of tile budget can — street
 * names do not appear until about zoom 14, and zoom 14 across 29 km is a thousand tiles.
 */
export function boxAroundPoint(
  centre: { lat: number; lon: number },
  acrossKm: number,
): LatLonBox {
  const halfLat = acrossKm / 2 / 111.32;
  const shrink = Math.max(0.2, Math.cos(toRad(centre.lat)));
  const halfLon = halfLat / shrink;
  return {
    minLat: centre.lat - halfLat,
    maxLat: centre.lat + halfLat,
    minLon: centre.lon - halfLon,
    maxLon: centre.lon + halfLon,
  };
}
