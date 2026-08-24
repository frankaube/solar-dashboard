import data from './coastline.data.json';

/**
 * Something under the rain.
 *
 * The radar composite carries precipitation and nothing else — Environment Canada publishes
 * 37,918 layers and not one of them is a basemap, because GeoMet is a data service rather
 * than a map. Drawn on its own, a radar frame is coloured blobs floating in an empty square:
 * you cannot tell a cell overhead from one over the next county, which makes it decoration
 * rather than information.
 *
 * So the geography is drawn here instead. Natural Earth's 1:50m coastlines, provincial and
 * state borders and lakes are public domain, and 700 kB of them ships inside the binary —
 * no tile server, no API key, no attribution banner, nothing fetched at runtime, and it
 * works for an array anywhere in the world including one with no internet at all.
 *
 * The projection is arithmetic rather than a library. The radar is requested as a plain
 * lat/lon bounding box, so a coordinate's position in the picture is just where it falls
 * between the edges — the one case where "unprojected" is exactly right.
 */

/**
 * What a line represents, so the client can draw a border differently from a shore.
 *
 * Country and province are separate because they are not equally useful: for an array near
 * a national boundary the international line is the landmark, and drawing it at the same
 * weight as a county edge throws that away.
 */
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

/**
 * Undo the delta encoding, once.
 *
 * Stored as deltas because neighbouring points on a coastline are close together: the same
 * 95,611 points are 1.4 MB written out in full and 700 kB as differences. Decoding is a
 * running sum, and the result is cached because the file never changes.
 */
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
 * The geography inside a box, ready to draw.
 *
 * Returned normalised rather than as coordinates, so the browser multiplies by the width it
 * happens to be rendering at and nothing has to agree about projections in two places.
 *
 * Points just outside the box are kept — one either side of every run that enters it —
 * because a line clipped exactly at the edge visibly stops short of it, and a coastline that
 * ends in mid-air looks like a rendering fault rather than the edge of the view.
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
    // Whole-feature rejection first: most of the world is not in a 3° box, and this skips
    // it with four comparisons instead of walking every point.
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
