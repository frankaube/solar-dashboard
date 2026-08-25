/**
 * A radar picture of the sky over this array. One image, not a slippy map — no tile library,
 * cache or pan/zoom state. Radar shows precipitation, which is not what limits a solar array:
 * it answers whether a cell went over, not why a day was dull. The server fetches it, not the
 * browser, so a tile request never carries the household's position to a third party's log.
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

/** ECCC GeoMet WMS: free, no key, the national forecast composite. `RADAR_1KM_RRAI` is rain. */
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
    // EPSG:4326 in WMS 1.3.0 is latitude-first. Backwards returns a valid image of the
    // wrong part of the world rather than an error.
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
 * Outside ECCC coverage. Needs a frame path from RainViewer's index — the identifier changes
 * every ten minutes and a URL built without one returns nothing. Scheme 2, smoothed.
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
