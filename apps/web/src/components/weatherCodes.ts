/**
 * WMO weather interpretation codes, as returned by Open-Meteo.
 *
 * Grouped into the handful of shapes worth drawing rather than the full 100-entry
 * table — a homeowner needs "is it sunny", not "slight freezing drizzle". The `kind`
 * drives the icon; the `label` is the plain-language line beside the temperature.
 *
 * Reference: https://open-meteo.com/en/docs (WMO Weather interpretation codes)
 */
export type SkyKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

export interface SkyRead {
  kind: SkyKind;
  label: string;
}

const TABLE: Array<{ codes: number[]; kind: SkyKind; label: string }> = [
  { codes: [0], kind: 'clear', label: 'clear sky' },
  { codes: [1], kind: 'clear', label: 'mainly clear' },
  { codes: [2], kind: 'partly', label: 'partly cloudy' },
  { codes: [3], kind: 'cloudy', label: 'overcast' },
  { codes: [45, 48], kind: 'fog', label: 'fog' },
  { codes: [51, 53, 55, 56, 57], kind: 'drizzle', label: 'drizzle' },
  { codes: [61, 63, 65, 66, 67], kind: 'rain', label: 'rain' },
  { codes: [80, 81, 82], kind: 'rain', label: 'showers' },
  { codes: [71, 73, 75, 77, 85, 86], kind: 'snow', label: 'snow' },
  { codes: [95, 96, 99], kind: 'storm', label: 'thunderstorm' },
];

export function readSky(code: number | undefined | null): SkyRead {
  if (code === undefined || code === null) return { kind: 'cloudy', label: '—' };
  const row = TABLE.find((entry) => entry.codes.includes(code));
  // Unknown codes are almost always precipitation variants; "unsettled" is honest
  // without inventing a specific condition we can't name.
  return row ? { kind: row.kind, label: row.label } : { kind: 'cloudy', label: 'unsettled' };
}

/** How good a solar day this is, from the sky alone — used for the caption. */
export function solarOutlook(kind: SkyKind): string {
  switch (kind) {
    case 'clear':
      return 'strong sun';
    case 'partly':
      return 'some sun';
    case 'fog':
    case 'cloudy':
      return 'little sun';
    default:
      return 'poor for solar';
  }
}
