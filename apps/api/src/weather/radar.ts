/**
 * A radar picture of the sky over this array.
 *
 * Deliberately one image rather than a slippy map. A map means a tile library, a tile
 * cache, pan and zoom state, and a browser talking to a third party on every drag — for a
 * question that is answered by a single square: is there weather over the house right now.
 *
 * WHAT THIS IS AND IS NOT FOR
 *
 * Radar shows precipitation, and precipitation is not what limits a solar array. A flat
 * grey overcast day returns no echo at all and produces half of nothing. So this does not
 * explain a dull day — the cloud panel on Trends does that, from data the app already has.
 *
 * What it answers is the sharper question: production fell off a cliff at two o'clock, and
 * the expected-versus-actual chart says so without saying why. A cell went over. That is
 * worth one image and nothing more.
 *
 * FETCHED BY THE SERVER, NOT THE BROWSER
 *
 * Every other picture in this app is drawn from local data. A tile fetched by the browser
 * would put the household's rough position in a request to somebody else's log, on every
 * page load, which is a different kind of thing from an opt-in upload. So the server
 * fetches it and serves the bytes: one machine talks outward, on a schedule, only when
 * switched on.
 */

/** Half-width of the picture in degrees — roughly 150 km of sky in each direction. */
export const SPAN_DEG = 1.5;

export type RadarSource = 'eccc' | 'rainviewer';

export interface RadarRequest {
  latitude: number;
  longitude: number;
  /** Pixels; the card renders about this wide. */
  size?: number;
}

/**
 * Environment and Climate Change Canada's GeoMet WMS.
 *
 * The authority for Canadian radar, free, no key, and the same composite the national
 * forecasts are built on. `RADAR_1KM_RRAI` is rain; there is a snow layer beside it, but
 * one picture that shows precipitation of any kind answers the question being asked.
 */
export function ecccUrl({ latitude, longitude, size = 512 }: RadarRequest): string {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: 'RADAR_1KM_RRAI',
    format: 'image/png',
    transparent: 'true',
    crs: 'EPSG:4326',
    width: String(size),
    height: String(size),
    /*
      EPSG:4326 in WMS 1.3.0 is latitude-first, which is the reverse of every other place a
      coordinate appears in this codebase. Getting it backwards returns a valid image of
      the wrong part of the world rather than an error, so it is written out here.
    */
    bbox: [
      latitude - SPAN_DEG,
      longitude - SPAN_DEG,
      latitude + SPAN_DEG,
      longitude + SPAN_DEG,
    ].join(','),
  });
  return `https://geo.weather.gc.ca/geomet?${params.toString()}`;
}

/** Slippy-map tile numbers for a coordinate, which RainViewer indexes by. */
export function tileOf(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((longitude + 180) / 360) * n);
  const latRad = (latitude * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

/**
 * RainViewer, for everywhere Environment Canada does not cover.
 *
 * Needs a frame path from its index first — the newest frame's identifier changes every ten
 * minutes, and a URL built without one returns nothing. Colour scheme 2 and the smoothed
 * option are the defaults their own viewer uses.
 */
export function rainviewerUrl(
  framePath: string,
  { latitude, longitude }: RadarRequest,
  zoom = 7,
): string {
  const { x, y } = tileOf(latitude, longitude, zoom);
  return `https://tilecache.rainviewer.com${framePath}/256/${zoom}/${x}/${y}/2/1_1.png`;
}

/** Canada, roughly — where the official composite has anything to say. */
export function coveredByEccc(latitude: number, longitude: number): boolean {
  return latitude >= 41 && latitude <= 70 && longitude >= -142 && longitude <= -52;
}

export function chooseSource(latitude: number, longitude: number): RadarSource {
  return coveredByEccc(latitude, longitude) ? 'eccc' : 'rainviewer';
}
