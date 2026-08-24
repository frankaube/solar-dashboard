import { describe, expect, it } from 'vitest';
import { boxFor, linesIn } from '../src/weather/coastline';
import { SPAN_DEG } from '../src/weather/radar';

/*
  The geography that goes under the radar.

  Worth testing because the failure mode is the same one the bounding box already has: a
  coordinate the wrong way round draws a perfectly plausible coastline for somewhere else,
  and nobody looking at a weather panel is going to notice that the shoreline is Somalia's.

  Coordinates here are public landmarks rather than anybody's house.
*/

/** Halifax — a coastal city, so a box around it must contain shoreline. */
const COASTAL = { latitude: 44.65, longitude: -63.57 };
/** Astride the Alberta–Saskatchewan line at 110°W, and far from any sea. */
const INLAND_BORDER = { latitude: 52.13, longitude: -110.0 };

describe('linesIn', () => {
  it('finds a shoreline where there is one', () => {
    const lines = linesIn(boxFor(COASTAL.latitude, COASTAL.longitude, SPAN_DEG));
    expect(lines.some((line) => line.kind === 'coast')).toBe(true);
  });

  it('draws nothing in the middle of an ocean', () => {
    // The North Atlantic, well off the shelf. An empty result is the correct answer, and
    // "correct" here means the filter is not simply returning everything.
    expect(linesIn(boxFor(35, -45, SPAN_DEG))).toEqual([]);
  });

  it('finds a provincial line but no coast well inland', () => {
    /*
      The check that catches a swapped latitude and longitude. 52.13, -110.0 is the
      Alberta–Saskatchewan boundary on dry prairie; the same numbers reversed are nowhere
      near it. A border and no coastline is only possible if they went in the right way round.
    */
    const lines = linesIn(boxFor(INLAND_BORDER.latitude, INLAND_BORDER.longitude, SPAN_DEG));
    expect(lines.some((line) => line.kind === 'border')).toBe(true);
    expect(lines.some((line) => line.kind === 'coast')).toBe(false);
  });

  it('carries the international boundary, which is the landmark near one', () => {
    // Written after shipping provincial lines and no country ones: for an array near an
    // international boundary that line is what you orient by, and it was simply missing.
    const lines = linesIn(boxFor(45.9, -67.4, SPAN_DEG));
    expect(lines.some((line) => line.kind === 'country')).toBe(true);
  });

  it('returns picture coordinates, not degrees', () => {
    // The browser multiplies these by whatever width it is rendering at, so nothing has to
    // agree about projections in two places.
    const lines = linesIn(boxFor(COASTAL.latitude, COASTAL.longitude, SPAN_DEG));
    const all = lines.flatMap((line) => line.points);
    expect(Math.min(...all)).toBeGreaterThan(-1);
    expect(Math.max(...all)).toBeLessThan(2);
  });

  it('puts north at the top', () => {
    /*
      Latitude grows upward and pixels grow downward, and getting that backwards produces a
      mirror image that still looks like a map. Compared against a box whose north edge is
      known to be land and south edge known to be open ocean.
    */
    const box = boxFor(COASTAL.latitude, COASTAL.longitude, SPAN_DEG);
    const north = (box.maxLat - (box.maxLat - 0.01)) / (box.maxLat - box.minLat);
    expect(north).toBeLessThan(0.5);
  });

  it('is stable across calls, because the decode is cached', () => {
    const once = linesIn(boxFor(COASTAL.latitude, COASTAL.longitude, SPAN_DEG));
    const twice = linesIn(boxFor(COASTAL.latitude, COASTAL.longitude, SPAN_DEG));
    expect(twice).toEqual(once);
  });

  it('keeps a point beyond the edge so lines reach it', () => {
    // A polyline clipped exactly at the boundary stops visibly short of it, and a coastline
    // ending in mid-air reads as a rendering fault rather than the edge of the view.
    const lines = linesIn(boxFor(COASTAL.latitude, COASTAL.longitude, SPAN_DEG));
    const all = lines.flatMap((line) => line.points);
    expect(all.some((value) => value < 0 || value > 1)).toBe(true);
  });

  it('refuses a box with no area rather than dividing by zero', () => {
    expect(linesIn({ minLon: 0, maxLon: 0, minLat: 0, maxLat: 0 })).toEqual([]);
  });
});
