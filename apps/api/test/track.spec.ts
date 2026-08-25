import { describe, expect, it } from 'vitest';
import {
  MAX_TRACK_POINTS,
  TrackPoint,
  bearingFrom,
  boxAround,
  distanceKm,
  scaleBar,
  thin,
} from '../src/charger/track';

/*
  The geometry behind the car map. Drawn from bundled vectors rather than tiles, so every
  number here is computed in-app rather than by a map library.
*/

/*
  A synthetic mid-latitude point — round numbers, nobody's house, and far enough north that
  the 1/cos(latitude) correction these tests exercise is a real effect.
*/
const HOME = { lat: 45.0, lon: -70.0 };
const point = (lat: number, lon: number, at = 0): TrackPoint => ({ lat, lon, at, speedKmh: 60 });

describe('thin', () => {
  it('leaves a short track alone', () => {
    const track = Array.from({ length: 50 }, (_, i) => point(46 + i / 1000, -64));
    expect(thin(track)).toHaveLength(50);
  });

  it('never drops the last point', () => {
    // The last point is where the car is; a stride that skips it leaves the marker trailing
    // its own track.
    const track = Array.from({ length: 5000 }, (_, i) => point(46 + i / 10000, -64, i));
    const out = thin(track);
    expect(out).toHaveLength(MAX_TRACK_POINTS);
    expect(out[out.length - 1]).toBe(track[track.length - 1]);
  });

  it('keeps the first point too, so the track starts where the drive did', () => {
    const track = Array.from({ length: 5000 }, (_, i) => point(46 + i / 10000, -64, i));
    expect(thin(track)[0]).toBe(track[0]);
  });

  it('samples evenly rather than taking a prefix', () => {
    const track = Array.from({ length: 4000 }, (_, i) => point(46 + i / 10000, -64, i));
    const out = thin(track, 5);
    // stride is 3999/4 = 999.75, so the interior indices round rather than landing on 1000s.
    expect(out.map((p) => p.at)).toEqual([0, 1000, 2000, 2999, 3999]);
  });
});

describe('boxAround', () => {
  it('has nothing to say about no points', () => {
    expect(boxAround([])).toBeNull();
  });

  it('widens longitude so the drive is not squashed east to west', () => {
    // At 46° north a degree of longitude is about 0.69 of a degree of latitude on the ground,
    // so a box equal in degrees compresses an east-west journey by a third.
    const box = boxAround([point(46, -64.5), point(46.1, -64.4)])!;
    const latSpan = box.maxLat - box.minLat;
    const lonSpan = box.maxLon - box.minLon;
    expect(lonSpan).toBeGreaterThan(latSpan);
    // Ground width and ground height should match to within a couple of percent.
    const wide = distanceKm({ lat: 45.05, lon: box.minLon }, { lat: 45.05, lon: box.maxLon });
    const tall = distanceKm({ lat: box.minLat, lon: -64.45 }, { lat: box.maxLat, lon: -64.45 });
    expect(Math.abs(wide - tall) / tall).toBeLessThan(0.02);
  });

  it('contains every point it was given', () => {
    const points = [point(46.0, -64.9), point(46.3, -64.2), point(45.9, -64.5)];
    const box = boxAround(points)!;
    for (const p of points) {
      expect(p.lat).toBeGreaterThanOrEqual(box.minLat);
      expect(p.lat).toBeLessThanOrEqual(box.maxLat);
      expect(p.lon).toBeGreaterThanOrEqual(box.minLon);
      expect(p.lon).toBeLessThanOrEqual(box.maxLon);
    }
  });

  it('does not collapse to a dot for a car that has not moved', () => {
    // A drive one sample old is a single point, and a zero-span box divides by zero later.
    const box = boxAround([point(45.0, -70.0)])!;
    expect(box.maxLat - box.minLat).toBeGreaterThan(0);
    expect(box.maxLon - box.minLon).toBeGreaterThan(0);
  });

  it('ignores a row with no coordinates rather than spanning the planet', () => {
    const box = boxAround([point(46.0, -64.9), { lat: NaN, lon: NaN }, point(46.2, -64.6)])!;
    expect(box.minLat).toBeGreaterThan(45);
    expect(box.maxLat).toBeLessThan(47);
  });
});

describe('distanceKm', () => {
  it('is zero for a point against itself', () => {
    expect(distanceKm(HOME, HOME)).toBeCloseTo(0, 6);
  });

  it('measures a degree of latitude at about 111 km', () => {
    expect(distanceKm({ lat: 46, lon: -64 }, { lat: 47, lon: -64 })).toBeCloseTo(111.2, 0);
  });
});

describe('bearingFrom', () => {
  it('names the four cardinals', () => {
    expect(bearingFrom(HOME, { lat: 46, lon: -70.0 })).toBe('N');
    expect(bearingFrom(HOME, { lat: 44, lon: -70.0 })).toBe('S');
    expect(bearingFrom(HOME, { lat: 45.0, lon: -68 })).toBe('E');
    expect(bearingFrom(HOME, { lat: 45.0, lon: -72 })).toBe('W');
  });

  it('names a diagonal', () => {
    expect(bearingFrom(HOME, { lat: 45.5, lon: -69.2 })).toBe('NE');
  });
});

describe('scaleBar', () => {
  it('picks a round number rather than a quarter of the width', () => {
    // A ruler, not a measurement: the bar length is rounded, not a fixed fraction of width.
    const box = boxAround([point(46.0, -64.9), point(46.4, -64.3)])!;
    const bar = scaleBar(box);
    expect([1, 2, 5, 10, 20, 50, 100]).toContain(bar.km);
  });

  it('stays inside the frame', () => {
    const box = boxAround([point(46.0, -64.9), point(46.4, -64.3)])!;
    expect(scaleBar(box).fraction).toBeGreaterThan(0);
    expect(scaleBar(box).fraction).toBeLessThan(1);
  });

  it('scales up for a long journey', () => {
    const short = scaleBar(boxAround([point(45.0, -70.0), point(45.02, -69.98)])!);
    const long = scaleBar(boxAround([point(45.0, -70.0), point(47.0, -67.2)])!);
    expect(long.km).toBeGreaterThan(short.km);
  });

  it('says nothing for a degenerate box rather than dividing by zero', () => {
    expect(scaleBar({ minLat: 46, maxLat: 46, minLon: -64, maxLon: -64 })).toEqual({ km: 0, fraction: 0 });
  });
});
