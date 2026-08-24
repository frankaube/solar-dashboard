import { describe, expect, it } from 'vitest';
import {
  boxAroundPoint,
  distanceKm,
  latOfTileY,
  scaleFor,
  tileX,
  tileY,
  tilesFor,
  zoomFor,
} from '../src/components/tileGrid';

/*
  Placing street tiles under a track drawn in lat/lon.

  Every number here exists because there is no map library doing it. The one that actually
  bites is Mercator: longitude is linear and latitude is not, and treating the second like
  the first slides the streets out from under the route — worse the further from the equator,
  and this roof is at 46 north.
*/

/*
  A synthetic mid-latitude window — round numbers, nobody's town, and far enough north that
  the Mercator error these tests exist to catch is a real effect.
*/
const TOWN = { minLat: 45.0, maxLat: 45.3, minLon: -70.2, maxLon: -69.8 };

describe('the projection', () => {
  it('puts the prime meridian and the equator at the middle of the world', () => {
    expect(tileX(0, 1)).toBeCloseTo(1, 9);
    expect(tileY(0, 1)).toBeCloseTo(1, 9);
  });

  it('round-trips a latitude through the tile grid', () => {
    // The inverse is what positions each image, so a drift here is streets out of place.
    for (const lat of [45.0, 0, -33.9, 60]) {
      expect(latOfTileY(tileY(lat, 14), 14)).toBeCloseTo(lat, 9);
    }
  });

  it('is not linear in latitude', () => {
    /*
      The whole point. Two spans of equal degrees are different heights on the map, and a
      linear placement would be wrong by the difference.
    */
    const low = tileY(0, 10) - tileY(10, 10);
    const high = tileY(60, 10) - tileY(70, 10);
    expect(high).toBeGreaterThan(low * 1.5);
  });

  it('does not blow up at either pole', () => {
    /*
      Found this: at 90 degrees tan and sec are both about 1e9 with opposite signs, cancel to
      zero, and log(0) is -Infinity — a tile index of NaN, placing an image nowhere. Clamped
      to Mercator's own limit instead, which is also the last latitude OSM has tiles for.
    */
    expect(Number.isFinite(tileY(90, 10))).toBe(true);
    expect(Number.isFinite(tileY(-90, 10))).toBe(true);
    expect(tileY(-90, 10)).toBeGreaterThan(tileY(90, 10));
  });
});

describe('zoomFor', () => {
  it('goes deeper for a smaller box', () => {
    const town = zoomFor(TOWN);
    const street = zoomFor({ minLat: 45.0, maxLat: 45.01, minLon: -70.01, maxLon: -69.99 });
    expect(street).toBeGreaterThan(town);
  });

  it('never asks for more tiles than the budget', () => {
    for (const box of [TOWN, { minLat: 40, maxLat: 50, minLon: -70, maxLon: -60 }]) {
      expect(tilesFor(box).length).toBeLessThanOrEqual(72);
    }
  });

  it('stays inside OSM’s zoom range', () => {
    const z = zoomFor({ minLat: -60, maxLat: 70, minLon: -170, maxLon: 170 });
    expect(z).toBeGreaterThanOrEqual(3);
    expect(z).toBeLessThanOrEqual(18);
  });
});

describe('tilesFor', () => {
  it('covers the whole box', () => {
    // Every edge of the window has to have a tile over it or the map has a bald strip.
    const tiles = tilesFor(TOWN);
    expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
    expect(Math.min(...tiles.map((t) => t.top))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.left + t.width))).toBeGreaterThanOrEqual(100);
    expect(Math.max(...tiles.map((t) => t.top + t.height))).toBeGreaterThanOrEqual(100);
  });

  it('gives every tile the same size', () => {
    // They are all one zoom, so a differing width would mean a placement bug.
    const tiles = tilesFor(TOWN);
    const w = tiles[0].width;
    const h = tiles[0].height;
    for (const t of tiles) {
      expect(t.width).toBeCloseTo(w, 6);
      expect(t.height).toBeCloseTo(h, 6);
    }
  });

  it('lays tiles out in a grid without gaps', () => {
    const tiles = tilesFor(TOWN);
    // Unrounded: rounding each edge first can push two of them a full unit apart.
    const lefts = [...new Set(tiles.map((t) => t.left))].sort((a, b) => a - b);
    for (let i = 1; i < lefts.length; i++) {
      expect(lefts[i] - lefts[i - 1]).toBeCloseTo(tiles[0].width, 6);
    }
  });

  it('says nothing about a degenerate box rather than dividing by zero', () => {
    expect(tilesFor({ minLat: 46, maxLat: 46, minLon: -64, maxLon: -64 })).toEqual([]);
  });
});

describe('scaleFor', () => {
  it('picks a round number rather than a quarter of the width', () => {
    const bar = scaleFor(TOWN);
    expect([0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]).toContain(bar.km);
  });

  it('draws a bar that fits inside the frame', () => {
    const bar = scaleFor(TOWN);
    expect(bar.fraction).toBeGreaterThan(0);
    expect(bar.fraction).toBeLessThan(1);
  });

  it('shrinks the bar when the view pulls in', () => {
    // The bar has to follow the drawn window, which is the whole reason it moved client-side.
    const wide = scaleFor(TOWN);
    const close = scaleFor(boxAroundPoint({ lat: 45.0, lon: -70.0 }, 2));
    expect(close.km).toBeLessThan(wide.km);
  });

  it('says nothing about a degenerate box rather than dividing by zero', () => {
    expect(scaleFor({ minLat: 46, maxLat: 46, minLon: -64, maxLon: -64 })).toEqual({
      km: 0,
      fraction: 0,
    });
  });
});

describe('boxAroundPoint', () => {
  const CAR = { lat: 45.35, lon: -69.7 };

  it('centres on the point it was given', () => {
    const box = boxAroundPoint(CAR, 2);
    expect((box.minLat + box.maxLat) / 2).toBeCloseTo(CAR.lat, 9);
    expect((box.minLon + box.maxLon) / 2).toBeCloseTo(CAR.lon, 9);
  });

  it('is the requested width on the ground, not in degrees', () => {
    const box = boxAroundPoint(CAR, 2);
    const across = distanceKm({ lat: CAR.lat, lon: box.minLon }, { lat: CAR.lat, lon: box.maxLon });
    expect(across).toBeCloseTo(2, 1);
  });

  it('is square on the ground', () => {
    // Longitude is widened per-latitude, or the streets round the car come out stretched.
    const box = boxAroundPoint(CAR, 2);
    const across = distanceKm({ lat: CAR.lat, lon: box.minLon }, { lat: CAR.lat, lon: box.maxLon });
    const down = distanceKm({ lat: box.minLat, lon: CAR.lon }, { lat: box.maxLat, lon: CAR.lon });
    expect(Math.abs(across - down) / down).toBeLessThan(0.02);
  });

  it('reaches a zoom where street names exist', () => {
    /*
      The entire point of the mode. Framing a 29 km journey lands on zoom 12; two kilometres
      around the car reaches 15, which is where OSM starts labelling streets.
    */
    expect(zoomFor(boxAroundPoint(CAR, 2))).toBeGreaterThanOrEqual(14);
  });
});
