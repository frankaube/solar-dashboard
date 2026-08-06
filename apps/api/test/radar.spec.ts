import { describe, expect, it } from 'vitest';
import {
  SPAN_DEG,
  chooseSource,
  coveredByEccc,
  ecccUrl,
  rainviewerUrl,
  tileOf,
} from '../src/weather/radar';

/*
  A picture of the sky over one house. Everything here is URL arithmetic, and the failure
  mode it guards against is the quiet one: a coordinate the wrong way round returns a
  perfectly valid image of the wrong part of the world, with no error anywhere.
*/

const HOME = { latitude: 45.96, longitude: -66.64 };

describe('ecccUrl', () => {
  it('puts latitude first in the bounding box', () => {
    /*
      WMS 1.3.0 with EPSG:4326 is latitude-first, the reverse of every other coordinate in
      this codebase. Backwards, it asks for a box off the coast of Somalia and gets a
      cloudless picture rather than a complaint.
    */
    const url = new URL(ecccUrl(HOME));
    const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
    expect(bbox[0]).toBeCloseTo(HOME.latitude - SPAN_DEG, 6);
    expect(bbox[1]).toBeCloseTo(HOME.longitude - SPAN_DEG, 6);
    expect(bbox[2]).toBeCloseTo(HOME.latitude + SPAN_DEG, 6);
    expect(bbox[3]).toBeCloseTo(HOME.longitude + SPAN_DEG, 6);
  });

  it('centres the box on the array', () => {
    const url = new URL(ecccUrl(HOME));
    const [minLat, minLon, maxLat, maxLon] = (url.searchParams.get('bbox') ?? '')
      .split(',')
      .map(Number);
    expect((minLat + maxLat) / 2).toBeCloseTo(HOME.latitude, 6);
    expect((minLon + maxLon) / 2).toBeCloseTo(HOME.longitude, 6);
  });

  it('asks for a transparent PNG, so it can sit over a map or nothing at all', () => {
    const url = new URL(ecccUrl(HOME));
    expect(url.searchParams.get('format')).toBe('image/png');
    expect(url.searchParams.get('transparent')).toBe('true');
    expect(url.searchParams.get('request')).toBe('GetMap');
  });

  it('honours the requested size', () => {
    const url = new URL(ecccUrl({ ...HOME, size: 320 }));
    expect(url.searchParams.get('width')).toBe('320');
    expect(url.searchParams.get('height')).toBe('320');
  });
});

describe('tileOf', () => {
  it('places a known coordinate on a known tile', () => {
    // Verified against the live tile server, which returned a 200 image/png for this.
    expect(tileOf(45.96, -66.64, 7)).toEqual({ x: 40, y: 45 });
  });

  it('moves east and south as the numbers say it should', () => {
    const home = tileOf(45.96, -66.64, 7);
    expect(tileOf(45.96, -60, 7).x).toBeGreaterThan(home.x);
    // Tile y grows downward, so a lower latitude is a larger y.
    expect(tileOf(40, -66.64, 7).y).toBeGreaterThan(home.y);
  });
});

describe('rainviewerUrl', () => {
  it('builds a tile URL from a frame path', () => {
    const url = rainviewerUrl('/v2/radar/83a0bc03f6bd', HOME, 7);
    expect(url).toBe('https://tilecache.rainviewer.com/v2/radar/83a0bc03f6bd/256/7/40/45/2/1_1.png');
  });
});

describe('choosing a source', () => {
  it('uses the official Canadian composite where it covers', () => {
    expect(coveredByEccc(45.96, -66.64)).toBe(true);
    expect(chooseSource(45.96, -66.64)).toBe('eccc');
  });

  it('falls back to the global one everywhere else', () => {
    // The repository is public; most people cloning it are not in Canada.
    expect(chooseSource(51.5, -0.12)).toBe('rainviewer');
    expect(chooseSource(-33.87, 151.2)).toBe('rainviewer');
  });
});
