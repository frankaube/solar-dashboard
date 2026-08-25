import data from './coastline.data.json';

/**
 * Geography to draw under the radar. GeoMet publishes no basemap, so a radar frame alone is
 * coloured blobs in an empty square. Natural Earth 1:50m is public domain and 700 kB of it
 * ships inside the binary: no tile server, no key, nothing fetched at runtime, works offline.
 * Projection is arithmetic, not a library — the radar is a plain lat/lon bounding box, so a
 * coordinate's position is where it falls between the edges.
 */

/** So the client can draw an international boundary at a different weight from a shore. */
export type FeatureKind = 'coast' | 'border' | 'lake' | 'country';

const KINDS: FeatureKind[] = ['coast', 'border', 'lake', 'country'];

/** Coordinates are stored as integer thousandths of a degree, delta-encoded. */
const UNIT = data.u;

interface Line {
  kind: FeatureKind;
  /** Flat [lon, lat, lon, lat, …] in degrees. */
  points: number[];
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

let decoded: Line[] | null = null;

/** Delta-encoded: the same 95,611 points are 1.4 MB written out and 700 kB as differences. */
function lines(): Line[] {
  if (decoded) return decoded;
  decoded = data.lines.map((encoded) => {
    const kind = KINDS[encoded[0]] ?? 'coast';
    const points: number[] = [];
    let x = 0;
    let y = 0;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (let i = 1; i < encoded.length; i += 2) {
      x += encoded[i];
      y += encoded[i + 1];
      const lon = x / UNIT;
      const lat = y / UNIT;
      points.push(lon, lat);
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return { kind, points, minLon, maxLon, minLat, maxLat };
  });
  return decoded;
}

export interface BoundingBox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/** A polyline in the picture's own coordinates: 0–1 across, 0–1 down. */
export interface DrawnLine {
  kind: FeatureKind;
  /** Flat [x, y, x, y, …]. */
  points: number[];
}

/**
 * Normalised to 0–1 so the browser multiplies by its own render width. Points just outside
 * the box are kept — one either side of every run that enters it — because a line clipped
 * exactly at the edge visibly stops short of it.
 */
export function linesIn(box: BoundingBox, margin = 0.25): DrawnLine[] {
  const lonSpan = box.maxLon - box.minLon;
  const latSpan = box.maxLat - box.minLat;
  if (lonSpan <= 0 || latSpan <= 0) return [];

  const wide = {
    minLon: box.minLon - lonSpan * margin,
    maxLon: box.maxLon + lonSpan * margin,
    minLat: box.minLat - latSpan * margin,
    maxLat: box.maxLat + latSpan * margin,
  };
  const inside = (lon: number, lat: number): boolean =>
    lon >= wide.minLon && lon <= wide.maxLon && lat >= wide.minLat && lat <= wide.maxLat;

  const out: DrawnLine[] = [];
  for (const line of lines()) {
    // Whole-feature rejection first: four comparisons instead of walking every point.
    if (
      line.maxLon < wide.minLon ||
      line.minLon > wide.maxLon ||
      line.maxLat < wide.minLat ||
      line.minLat > wide.maxLat
    ) {
      continue;
    }

    let run: number[] = [];
    const flush = (): void => {
      if (run.length >= 4) out.push({ kind: line.kind, points: run });
      run = [];
    };
    for (let i = 0; i < line.points.length; i += 2) {
      const lon = line.points[i];
      const lat = line.points[i + 1];
      const here = inside(lon, lat);
      const previousInside =
        i >= 2 && inside(line.points[i - 2], line.points[i - 1]);
      if (here || previousInside) {
        const x = (lon - box.minLon) / lonSpan;
        // Latitude grows upward and pixels grow downward.
        const y = (box.maxLat - lat) / latSpan;
        run.push(Math.round(x * 10_000) / 10_000, Math.round(y * 10_000) / 10_000);
        if (!here) flush();
      } else if (run.length) {
        flush();
      }
    }
    flush();
  }
  return out;
}

/** The box the radar picture covers, from the site and the span the request uses. */
export function boxFor(latitude: number, longitude: number, span: number): BoundingBox {
  return {
    minLon: longitude - span,
    maxLon: longitude + span,
    minLat: latitude - span,
    maxLat: latitude + span,
  };
}
