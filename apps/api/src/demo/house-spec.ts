/**
 * A house you can describe, instead of the one house this demo used to be.
 *
 * Demo mode generated a single fixed home — 24 kW, 48 panels, a 13.5 kWh battery, at
 * latitude 46. Good for a screenshot, useless for the question people actually arrive
 * with, which is some version of "what would this look like for MY house" or "what
 * would a battery get me". A spec turns those constants into inputs.
 *
 * HONESTY RULE, and it is the whole reason this file is careful:
 *
 * Everything here is a MODEL. It is not a solar estimate, a quote, or a prediction.
 * A number produced from a HouseSpec must never be presented in the same visual
 * language as a number measured from real hardware — the fixture catalogue next door
 * already draws that line with `Provenance`, and this is the same line. The model is
 * good enough to answer "roughly how much, and is a battery worth thinking about";
 * it is not good enough to spend money on, and anything built on top must say so.
 */

/** Wh produced per kW installed, per day, before losses — see peakSunHours. */
const CLEARNESS = 0.39;

/** Panel degradation, a industry-standard figure and about right for any modern panel. */
export const DEGRADATION_PER_YEAR = 0.005;

export interface Location {
  label: string;
  latitude: number;
  /** IANA zone. Drives which calendar day a reading lands on. */
  timezone: string;
}

export interface SolarSpec {
  panelCount: number;
  panelWatts: number;
}

export interface BatterySpec {
  label: string;
  capacityKwh: number;
  /** Depth of discharge a pack will actually give you. */
  usableFraction: number;
}

export interface EvSpec {
  label: string;
  batteryKwh: number;
  kmPerYear: number;
  kwhPerKm: number;
  chargerKw: number;
}

export type HeatingKind = 'none' | 'baseboard' | 'heat-pump';

export interface TariffSpec {
  retailPerKwh: number;
  /** Sales tax charged on power you buy — the self-consumption premium depends on it. */
  taxRate: number;
  /** Which programme values the flows; resolved against reward-programs.ts. */
  programId: string;
}

export interface HouseSpec {
  label: string;
  location: Location;
  solar: SolarSpec | null;
  battery: BatterySpec | null;
  ev: EvSpec | null;
  heating: HeatingKind;
  tariff: TariffSpec;
}

// ---------------------------------------------------------------------------
// Catalogue — real products with published specs, so the builder offers things
// someone can actually go and buy rather than abstract kWh sliders.
// ---------------------------------------------------------------------------

export const PANEL_OPTIONS = [
  { id: 'std-400', label: '400 W (typical residential)', watts: 400 },
  { id: 'std-450', label: '450 W', watts: 450 },
  { id: 'std-500', label: '500 W (large format)', watts: 500 },
];

export const BATTERY_OPTIONS: Array<BatterySpec & { id: string }> = [
  { id: 'none', label: 'No battery', capacityKwh: 0, usableFraction: 0 },
  { id: 'ecoflow-delta-pro', label: 'EcoFlow DELTA Pro', capacityKwh: 3.6, usableFraction: 0.9 },
  { id: 'ecoflow-delta-pro-3x', label: 'EcoFlow DELTA Pro ×3', capacityKwh: 10.8, usableFraction: 0.9 },
  { id: 'enphase-iq5p', label: 'Enphase IQ Battery 5P', capacityKwh: 5, usableFraction: 0.9 },
  { id: 'powerwall-3', label: 'Tesla Powerwall 3', capacityKwh: 13.5, usableFraction: 0.95 },
];

export const EV_OPTIONS: Array<EvSpec & { id: string }> = [
  { id: 'none', label: 'No EV', batteryKwh: 0, kmPerYear: 0, kwhPerKm: 0, chargerKw: 0 },
  { id: 'model-3', label: 'Tesla Model 3', batteryKwh: 57.5, kmPerYear: 20000, kwhPerKm: 0.15, chargerKw: 11 },
  { id: 'model-y', label: 'Tesla Model Y', batteryKwh: 75, kmPerYear: 20000, kwhPerKm: 0.17, chargerKw: 11 },
  { id: 'ioniq-5', label: 'Hyundai IONIQ 5', batteryKwh: 77.4, kmPerYear: 18000, kwhPerKm: 0.18, chargerKw: 10.9 },
  { id: 'lightning', label: 'Ford F-150 Lightning', batteryKwh: 98, kmPerYear: 18000, kwhPerKm: 0.29, chargerKw: 11.3 },
];

// ---------------------------------------------------------------------------
// Solar geometry
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;

/** Solar declination for a day of year, in degrees. */
export function declination(doy: number): number {
  return 23.44 * Math.sin(RAD * ((360 / 365) * (doy - 81)));
}

/**
 * Hours between sunrise and sunset.
 *
 * Clamped because inside the polar circles the hour-angle term leaves [-1, 1] and the
 * honest answers there are 0 and 24, not NaN.
 */
export function dayLength(latitude: number, doy: number): number {
  const ratio = -Math.tan(RAD * latitude) * Math.tan(RAD * declination(doy));
  if (ratio <= -1) return 24;
  if (ratio >= 1) return 0;
  return (2 * Math.acos(ratio)) / RAD / 15;
}

/** Sun's altitude at solar noon, in degrees. Negative during a polar night. */
export function noonElevation(latitude: number, doy: number): number {
  return 90 - Math.abs(latitude - declination(doy));
}

/**
 * Peak sun hours for a latitude-tilted array — the kWh a 1 kW array makes on a clear
 * day.
 *
 * Day length alone is not enough: a 15-hour midsummer day at 60°N still has a low sun,
 * and a panel cares about the angle it arrives at. Multiplying day length by the sine
 * of the noon elevation captures both, and one clearness constant scales the result to
 * reality.
 *
 * CALIBRATION. `CLEARNESS = 0.39` was fitted so this reproduces the two constants the
 * old fixed demo used — 135 kWh/day peak and 26 kWh/day trough for a 24 kW array at
 * 46.09°N — which it does to within about 7%. That is the extent of the validation:
 * one array, one latitude, matched against numbers that were themselves hand-tuned.
 *
 * KNOWN BIAS: pessimistic about low-latitude winters. Using the sun's elevation above
 * the HORIZON is the right proxy for a flat panel, not a tilted one — a tilted array
 * meets the winter sun much more squarely than this implies. Measured against the
 * model, Phoenix reads as a winter/summer ratio near 0.38 where reality is closer to
 * 0.55. The error shrinks toward the calibration latitude and reverses direction
 * nowhere, so rankings stay right and magnitudes drift. Fixing it properly means
 * modelling tilt and air mass, which is more machinery than a demo needs — but nothing
 * built on this should quote a sun-belt winter figure as though it were an estimate.
 */
export function peakSunHours(latitude: number, doy: number): number {
  const elevation = noonElevation(latitude, doy);
  if (elevation <= 0) return 0;
  return dayLength(latitude, doy) * Math.sin(RAD * elevation) * CLEARNESS;
}

/** Clear-sky kWh for a whole array on a given day, before weather and age. */
export function clearSkyKwh(spec: HouseSpec, doy: number): number {
  if (!spec.solar) return 0;
  const kw = (spec.solar.panelCount * spec.solar.panelWatts) / 1000;
  return kw * peakSunHours(spec.location.latitude, doy);
}

/** Installed capacity in kW. */
export function systemKw(spec: HouseSpec): number {
  if (!spec.solar) return 0;
  return (spec.solar.panelCount * spec.solar.panelWatts) / 1000;
}

/**
 * Annual household consumption, in kWh.
 *
 * Rough by construction: a base load plus whatever the heating choice and the EV add.
 * It exists so self-consumption has something to be a fraction OF — a house with a
 * heat pump and an EV soaks up far more of its own solar than an empty one, and a
 * model that ignores that would make batteries look identically useful everywhere.
 */
export function annualConsumptionKwh(spec: HouseSpec): number {
  const BASE = 7000;
  const heating = spec.heating === 'baseboard' ? 12000 : spec.heating === 'heat-pump' ? 5000 : 0;
  const ev = spec.ev ? spec.ev.kmPerYear * spec.ev.kwhPerKm : 0;
  return BASE + heating + ev;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * The house the demo used to hardcode, expressed as a spec.
 *
 * The system size, battery, EV and heating are kept exact so the refactor stays
 * verifiable: switching demo mode from constants to this preset must not move the
 * generated dataset. The location is not part of that claim — it was moved off the
 * developer’s own city before this went public, which shifts output by well under the
 * calibration tolerance below.
 */
export const DEFAULT_HOUSE: HouseSpec = {
  label: 'Large — 24 kW with a battery',
  location: { label: 'Ottawa, ON', latitude: 45.42, timezone: 'America/Toronto' },
  solar: { panelCount: 48, panelWatts: 500 },
  battery: { label: 'Tesla Powerwall 3', capacityKwh: 13.5, usableFraction: 0.95 },
  ev: { label: 'Demo EV', batteryKwh: 75, kmPerYear: 20000, kwhPerKm: 0.17, chargerKw: 11 },
  heating: 'heat-pump',
  tariff: { retailPerKwh: 0.16, taxRate: 0.13, programId: 'net-metering' },
};

export const PRESETS: HouseSpec[] = [
  DEFAULT_HOUSE,
  {
    label: 'Starter — 6 kW, no battery',
    location: { label: 'Toronto, ON', latitude: 43.65, timezone: 'America/Toronto' },
    solar: { panelCount: 15, panelWatts: 400 },
    battery: null,
    ev: null,
    heating: 'none',
    tariff: { retailPerKwh: 0.13, taxRate: 0.13, programId: 'net-metering' },
  },
  {
    label: 'Sun belt — 10 kW, EV, no battery',
    location: { label: 'Phoenix, AZ', latitude: 33.45, timezone: 'America/Phoenix' },
    solar: { panelCount: 22, panelWatts: 450 },
    battery: null,
    ev: EV_OPTIONS[1],
    heating: 'none',
    tariff: { retailPerKwh: 0.15, taxRate: 0.086, programId: 'net-metering' },
  },
  {
    label: 'Northern — 8 kW, big battery',
    location: { label: 'Stockholm, SE', latitude: 59.33, timezone: 'Europe/Stockholm' },
    solar: { panelCount: 20, panelWatts: 400 },
    battery: BATTERY_OPTIONS[4],
    ev: null,
    heating: 'heat-pump',
    tariff: { retailPerKwh: 0.22, taxRate: 0.25, programId: 'feed-in-tariff' },
  },
];

export function findPreset(label: string | undefined): HouseSpec | undefined {
  return PRESETS.find((p) => p.label === label);
}
