import { useCallback, useEffect, useRef, useState } from 'react';

export interface Summary {
  updatedAt: string | null;
  currentPowerW: number;
  todayEnergyWh: number;
  todayRevenue: number;
  pricePerKwh: number;
  gridVoltage: number | null;
  gridFrequency: number | null;
  invertersOnline: number;
  invertersTotal: number;
  ratedKw: number;
  ratedKwConfigured: boolean;
  panelsTotal: number;
}

export interface InverterSnapshot {
  serialNumber: string;
  gridVoltage: number;
  gridFrequency: number;
  activePower: number;
  temperature: number;
  linkStatus: number;
  rfSignal: number;
}

export interface PortSnapshot {
  inverterSerialNumber: string;
  portNumber: number;
  voltage: number;
  current: number;
  power: number;
  energyDailyWh: number;
}

export interface Snapshot {
  dtuSerialNumber: string;
  takenAt: string;
  totalPower: number;
  dailyEnergyWh: number;
  inverters: InverterSnapshot[];
  ports: PortSnapshot[];
}

export interface PowerPoint {
  t: string;
  powerW: number;
  /** Absent for readings the app polled; "cloud" for a point imported to fill a gap. */
  source?: string;
}

export interface DailyEnergy {
  date: string;
  energyWh: number;
}

export interface EnergyStats {
  todayWh: number;
  monthWh: number;
  yearWh: number;
  lifetimeWh: number;
  pricePerKwh: number;
  savings: { today: number; month: number; year: number; lifetime: number };
  systemCostCad: number | null;
  paybackProgressPct: number | null;
  co2SavedKg: number;
  records: {
    bestDayDate: string | null;
    bestDayWh: number;
    peakPowerW: number;
    peakPowerAt: string | null;
    daysCollecting: number;
  };
}

export interface Alert {
  id: number;
  type: string;
  severity: 'warning' | 'serious';
  subjectKey: string;
  message: string;
  openedAt: string;
  closedAt: string | null;
  ackedAt: string | null;
}

export interface Alerts {
  active: Alert[];
  recentlyClosed: Alert[];
}

export interface CurrentWeather {
  takenAt: string;
  temperature: number;
  cloudCover: number;
  windSpeed: number;
  weatherCode: number;
  shortwaveRadiation: number;
}

export interface DailyForecast {
  date: string;
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  radiationSum: number | null;
  sunrise: string | null;
  sunset: string | null;
}

export interface Weather {
  current: CurrentWeather | null;
  daily: { sunrise: string[]; sunset: string[] } | null;
  /** Day 0 is today; the card shows the next three. */
  forecast?: DailyForecast[];
}

export interface ExpectedActualPoint {
  t: string;
  actualW: number;
  expectedW: number | null;
}

export interface DayOutlook {
  date: string;
  expectedWh: number;
}

export interface ProductionAnalytics {
  wattsPerIrradiance: number | null;
  points: ExpectedActualPoint[];
  tomorrowForecastWh: number | null;
  chargeWindow: { start: string; end: string; estKwh: number; avgKw: number } | null;
  /** Expected output per forecast day, from this array's learned response. Empty until learned. */
  outlook: DayOutlook[];
}

export interface TempPowerPoint {
  temperature: number;
  powerW: number;
}

export interface ChargerLive {
  vehicleConnected: boolean;
  charging: boolean;
  powerW: number;
  sessionEnergyWh: number;
  sessionSeconds: number;
  gridVoltage: number;
  lifetimeEnergyWh: number | null;
  chargeStarts: number | null;
  updatedAt: string;
}

export interface Config {
  electricityPricePerKwh: number;
  systemCostCad: number | null;
  hstRate: number;
  systemRatedKw: number | null;
  /** Which tariff values the energy. Absent installs resolve to net metering. */
  rewardProgramId: string;
  /** Whether the configured price already has sales tax in it. */
  priceIncludesTax: boolean;
  /** Owner's estimate of the share used as it is made, when nothing measures it. */
  selfConsumptionPct: number | null;
  /** True when that share is measured from meter data instead of the typed figure. */
  selfConsumptionAuto: boolean;
}

/** What the meter says the self-consumption share really is, for Settings to offer. */
export interface SelfConsumptionEstimate {
  /** Percent, or null when the record cannot support a figure — `reason` says why. */
  pct: number | null;
  days: number;
  producedKwh: number;
  selfConsumedKwh: number;
  reason: string | null;
  enabled: boolean;
  configuredPct: number | null;
}

export interface ProgramOption {
  id: string;
  label: string;
  description: string;
  /** True when the rates are defined relative to the retail price. */
  needsRetail: boolean;
}

export interface SavingsPeriod {
  producedKwh: number;
  selfConsumedKwh: number;
  exportedKwh: number;
  grossValue: number;
  netMeteringValue: number;
  bonusCaptured: number;
  realizedSaved: number;
  bonusForegone: number;
  selfConsumptionPct: number;
  /** True when any part of the period leaned on your estimate rather than a meter. */
  selfConsumptionEstimated: boolean;
  /**
   * Production whose self-consumption was measured at a meter, in kWh.
   *
   * Against producedKwh this gives the share that rests on a measurement — which the flag
   * above cannot, being one bit for a period that is routinely part measured and part not.
   */
  measuredProducedKwh: number;
  /** The chosen programme itemised — general, unlike the net-metering-specific fields. */
  lines: Array<{ id: string; label: string; amount: number; realised: boolean; note?: string }>;
  programName: string;
}

export interface Savings {
  rates: {
    retailPerKwh: number;
    hstRate: number;
    /** What the chosen programme pays per kWh, and for which flow. */
    perKwh: Array<{
      ruleId: string;
      label: string;
      ratePerKwh: number;
      applies: "produced" | "selfConsumed" | "exported" | "imported";
      realised: boolean;
    }>;
    /** What one more kWh is worth used at home versus exported. */
    marginal: {
      selfConsumedPerKwh: number;
      exportedPerKwh: number;
      selfConsumedLowPerKwh: number;
      exportedLowPerKwh: number;
      /** True when the value depends on WHEN the kWh flowed. */
      varies: boolean;
    };
  };
  today: SavingsPeriod;
  month: SavingsPeriod;
  year: SavingsPeriod;
  lifetime: SavingsPeriod;
  measured: { evSolarKwhLifetime: number; batteryDischargeKwhLifetime: number };
  systemCostCad: number | null;
  paybackProgressPct: number | null;
}

export interface CensusFinding {
  id: string;
  severity: "info" | "warning" | "serious";
  headline: string;
  detail: string;
}

export interface Census {
  claims: Array<{ source: string; panels: number | null; ratedKw: number | null }>;
  findings: CensusFinding[];
  believedRatedKw: number | null;
  believedFrom: string | null;
}

export interface Capabilities {
  solar: { id: string; name: string } | null;
  pollIntervalMs: number | null;
  metricsPath: string;
  healthPath: string;
  /** The EV charger this install polls, or null when none is configured. */
  charger: { id: string; name: string } | null;
  /** The vehicle logger, present only once it has actually produced data. */
  vehicle: { id: string; name: string; setupUrl: string | null } | null;
  /** Whether announcement-based discovery can work from where the app runs. */
  discovery: { onDeviceSubnet: boolean; localSubnets: string[]; blindReason: string | null };
  /** What can actually be seen going into the house rather than out to the grid. */
  selfConsumptionSources: Array<{ id: string; label: string }>;
}

export interface ManualVendor {
  id: string;
  name: string;
  kind: string;
  port: number;
  readableWithoutCredentials: boolean;
  credentialLabel: string | null;
  /** Whether the hardware can report watts at all — separate from whether we can reach it. */
  metersEnergy: boolean;
  note: string | null;
}

export const fetchManualVendors = (): Promise<ManualVendor[]> =>
  getJson("/api/devices/manual-vendors");

export const addDeviceManually = async (input: {
  vendor: string;
  host: string;
  name?: string;
  credential?: string;
}): Promise<{ device: { id: number; name: string }; readable: boolean; note: string | null }> => {
  const response = await fetch("/api/devices/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
  return body as { device: { id: number; name: string }; readable: boolean; note: string | null };
};

export const fetchCapabilities = (): Promise<Capabilities> => getJson("/api/system/capabilities");

export const fetchCensus = (): Promise<Census> => getJson("/api/system/census");
export const fetchArrayContract = (): Promise<{ panels: number | null; wattsPerPanel: number | null }> =>
  getJson("/api/system/array");

export const saveArrayContract = async (
  panels: number | null,
  wattsPerPanel: number | null,
): Promise<Census> => {
  const response = await fetch("/api/system/array", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ panels, wattsPerPanel }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as Census;
};

export interface PanelMeta {
  id: number;
  portNumber: number;
  label: string | null;
  wattage: number | null;
  gridX: number | null;
  gridY: number | null;
  inverterSerial: string;
}

const DEMO_KEY = 'solar-demo-mode';

export function isDemoMode(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(DEMO_KEY) === 'on';
}

export function setDemoMode(on: boolean): void {
  if (on) localStorage.setItem(DEMO_KEY, 'on');
  else localStorage.removeItem(DEMO_KEY);
}

const FIXTURE_KEY = 'solar-demo-fixture';

/** Which recorded device demo mode is standing in for, or null for generated data. */
export function demoFixture(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(FIXTURE_KEY);
}

export function setDemoFixture(id: string | null): void {
  if (id) localStorage.setItem(FIXTURE_KEY, id);
  else localStorage.removeItem(FIXTURE_KEY);
}

const HOUSE_KEY = 'solar-demo-house';

/**
 * The house demo mode is currently showing, if the builder set one.
 *
 * Stored client-side and sent with each request rather than held on the server, so a
 * single hosted demo can serve many visitors each exploring a different house without
 * any of them changing what the others see.
 */
export function demoHouse(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(HOUSE_KEY);
}

/** base64url, because the value rides in query strings and in shared links. */
export function encodeHouse(spec: unknown): string {
  const json = JSON.stringify(spec);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeHouse<T>(encoded: string): T | null {
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    // A truncated or hand-edited link should land on the default house, not a crash.
    return null;
  }
}

export function setDemoHouse(spec: unknown | null): void {
  if (!spec) {
    localStorage.removeItem(HOUSE_KEY);
    return;
  }
  localStorage.setItem(HOUSE_KEY, encodeHouse(spec));
}

/** In demo mode, GET reads are redirected to the generated /api/demo/* dataset. */
function demoize(url: string): string {
  if (!isDemoMode() || !url.startsWith('/api/')) return url;
  /*
    Already-demo URLs must pass through untouched.

    The builder's own endpoints live under /api/demo/ by nature — they are demo
    features — and blindly prefixing turned /api/demo/house/options into
    /api/demo/demo/house/options, a 404. The page then hung on "Loading the
    catalogue…" precisely when demo mode was on, which is the only time anyone would
    open it.
  */
  const demoUrl = url.startsWith('/api/demo/') ? url : url.replace('/api/', '/api/demo/');
  const spec = demoHouse();
  if (!spec) return demoUrl;
  return `${demoUrl}${demoUrl.includes('?') ? '&' : '?'}house=${spec}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(demoize(url));
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

/**
 * POST a block of text rather than a JSON envelope.
 *
 * For pasted exports, where the payload is the file. Surfaces the server's own message
 * instead of a status code, because the useful half of a refused import — "date must be
 * YYYY-MM-DD", "no gateway recorded yet" — is in the body.
 */
async function postText<T>(url: string, body: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
  });
  const parsed = await response.json().catch(() => ({}) as { message?: string });
  if (!response.ok) {
    throw new Error((parsed as { message?: string }).message ?? `${url} → HTTP ${response.status}`);
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// House builder — demo-only. Everything it returns is MODELLED, never measured.
// ---------------------------------------------------------------------------

export interface HouseLocation {
  label: string;
  latitude: number;
  timezone: string;
}

export interface HouseSpec {
  label: string;
  location: HouseLocation;
  solar: { panelCount: number; panelWatts: number } | null;
  battery: { label: string; capacityKwh: number; usableFraction: number } | null;
  ev: {
    label: string;
    batteryKwh: number;
    kmPerYear: number;
    kwhPerKm: number;
    chargerKw: number;
  } | null;
  heating: 'none' | 'baseboard' | 'heat-pump';
  tariff: { retailPerKwh: number; taxRate: number; programId: string };
}

export interface AnnualFlows {
  producedKwh: number;
  consumedKwh: number;
  selfConsumedKwh: number;
  exportedKwh: number;
  importedKwh: number;
  selfConsumptionPct: number;
}

export interface HouseValuation {
  spec: HouseSpec;
  flows: AnnualFlows;
  valuation: {
    lines: Array<{ ruleId: string; label: string; amount: number; realised: boolean }>;
    realised: number;
    foregone: number;
    ceiling: number;
    unsupported: string[];
  };
  systemKw: number;
  billWithoutSolarPerYear: number;
  billWithSolarPerYear: number;
}

export interface HouseComparison {
  before: HouseValuation;
  after: HouseValuation;
  realisedDeltaPerYear: number;
  producedDeltaKwh: number;
  selfConsumptionDeltaPct: number;
  /** null means it never pays back — render that, do not render a blank. */
  paybackYears: number | null;
}

export interface HouseOptions {
  presets: HouseSpec[];
  panels: Array<{ id: string; label: string; watts: number }>;
  batteries: Array<{ id: string; label: string; capacityKwh: number; usableFraction: number }>;
  evs: Array<{
    id: string;
    label: string;
    batteryKwh: number;
    kmPerYear: number;
    kwhPerKm: number;
    chargerKw: number;
  }>;
  heating: string[];
  programs: Array<{ id: string; label: string }>;
}

export const fetchHouseOptions = (): Promise<HouseOptions> =>
  getJson('/api/demo/house/options');

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

export const valueHouse = (spec: HouseSpec): Promise<HouseValuation> =>
  postJson('/api/demo/house/value', { spec });

export const compareHouses = (
  before: HouseSpec,
  spec: HouseSpec,
  capitalCost = 0,
): Promise<HouseComparison> =>
  postJson('/api/demo/house/value', { before, spec, capitalCost });

export interface BackupDestinationInfo {
  id: string;
  name: string;
  summary: string;
  setupHint: string;
  fields: Array<{
    key: string;
    label: string;
    secret?: boolean;
    placeholder?: string;
    help?: string;
    optional?: boolean;
    /** Set by a connect flow rather than typed — the form skips it. */
    hidden?: boolean;
  }>;
}

export interface BackupFrequency {
  id: string;
  label: string;
  ms: number;
  /** Whether the preferred hour applies. False for anything under a day. */
  anchored: boolean;
}

export interface BackupDestinationStatus {
  kind: string;
  name: string;
  describe: string;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  lastSizeBytes: number | null;
  listError: string | null;
  backups: Array<{ name: string; sizeBytes: number; modifiedAt: string }>;
}

export interface BackupStatus {
  enabled: string[];
  configured: boolean;
  schedule: string;
  hour: number;
  scheduleText: string;
  keep: number;
  destinations: BackupDestinationStatus[];
}

export const fetchBackupDestinations = (): Promise<BackupDestinationInfo[]> =>
  getJson("/api/backup/destinations");
export const fetchBackupStatus = (): Promise<BackupStatus> => getJson("/api/backup/status");
export const fetchBackupFrequencies = (): Promise<BackupFrequency[]> =>
  getJson("/api/backup/frequencies");
export interface BackupConfig {
  enabled: string[];
  kinds: Record<string, { values: Record<string, string>; secretsSet: Record<string, boolean> }>;
}
export const fetchBackupConfig = (): Promise<BackupConfig> => getJson("/api/backup/config");
export const testBackup = (kind: string, config: Record<string, string>): Promise<{ ok: boolean; error?: string }> =>
  postJson("/api/backup/test", { kind, config });
export const disconnectGoogleDrive = (): Promise<BackupStatus> =>
  postJson("/api/backup/oauth/google/disconnect", {});
export const runBackupNow = (): Promise<{
  ok: boolean;
  name?: string;
  results: Array<{ kind: string; ok: boolean; sizeBytes?: number; error?: string }>;
  error?: string;
}> => postJson("/api/backup/run", {});
export const saveBackupConfig = async (input: {
  enabled: string[];
  configs: Record<string, Record<string, string>>;
  schedule: string;
  keep: number;
  hour: number;
}): Promise<void> => {
  const response = await fetch("/api/backup/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `HTTP ${response.status}`);
  }
};

export interface PortHistoryPoint {
  t: string;
  powerW: number;
  voltage: number;
  current: number;
}

export interface WeatherHistoryPoint {
  t: string;
  irradiance: number | null;
  cloudCover: number;
}

export const fetchSummary = (): Promise<Summary> => getJson('/api/summary');
export const fetchPortHistory = (id: number, hours: number): Promise<PortHistoryPoint[]> =>
  getJson(`/api/history/port/${id}?hours=${hours}`);
export const fetchWeatherHistory = (hours: number): Promise<WeatherHistoryPoint[]> =>
  getJson(`/api/history/weather?hours=${hours}`);
export const fetchLive = (): Promise<{ snapshot: Snapshot | null }> => getJson('/api/live');
export const fetchPowerHistory = (hours: number): Promise<PowerPoint[]> =>
  getJson(`/api/history/power?hours=${hours}`);
export const fetchEnergyHistory = (days: number): Promise<DailyEnergy[]> =>
  getJson(`/api/history/energy?days=${days}`);
export const fetchStats = (): Promise<EnergyStats> => getJson('/api/stats');
export const fetchSavings = (): Promise<Savings> => getJson('/api/savings');
export const fetchAlerts = (): Promise<Alerts> => getJson('/api/alerts');
export const fetchWeather = (): Promise<Weather> => getJson('/api/weather');
export const fetchConfig = (): Promise<Config> => getJson('/api/config');
export const fetchSelfConsumptionEstimate = (): Promise<SelfConsumptionEstimate> =>
  getJson('/api/savings/self-consumption');
export const fetchPanels = (): Promise<PanelMeta[]> => getJson('/api/panels');
export const fetchPrograms = (): Promise<ProgramOption[]> => getJson('/api/config/programs');
export const saveConfig = (config: Partial<Config>): Promise<Config> =>
  putJson('/api/config', config);
export const savePanel = (
  id: number,
  meta: { label: string | null; wattage: number | null },
): Promise<PanelMeta> => putJson(`/api/panels/${id}`, meta);
export const savePanelPosition = (
  id: number,
  position: { gridX: number | null; gridY: number | null },
): Promise<object> => putJson(`/api/panels/${id}/position`, position);
export const fetchProductionAnalytics = (hours: number): Promise<ProductionAnalytics> =>
  getJson(`/api/analytics/production?hours=${hours}`);
export const fetchTempPower = (hours: number): Promise<TempPowerPoint[]> =>
  getJson(`/api/analytics/temp-power?hours=${hours}`);
export const fetchVoltagePower = (hours: number): Promise<Array<{ voltage: number; powerW: number }>> =>
  getJson(`/api/analytics/voltage-power?hours=${hours}`);
export const ackAlert = (id: number): Promise<object> => putJson(`/api/alerts/${id}/ack`, {});
export interface Vehicle {
  name: string;
  model: string;
  state: string;
  batteryLevel: number | null;
  rangeKm: number | null;
  odometerKm: number | null;
  charging: { startedAt: string; energyAddedKwh: number } | null;
  motion: { driving: boolean; speedKmh: number | null; since: string | null };
  /** null when no home is set or the car has no fix — distinct from "somewhere else". */
  atHome: boolean | null;
  lastSeenAt: string | null;
  updatedAt: string;
}

export const fetchCharger = (): Promise<{ live: ChargerLive | null; vehicle: Vehicle | null }> =>
  getJson('/api/charger');

export interface VehicleDetails {
  vehicle: Vehicle | null;
  battery: Array<{ t: string; level: number }>;
  drives: Array<{
    startedAt: string;
    from: string | null;
    to: string | null;
    distanceKm: number;
    durationMin: number;
    consumptionKwh: number | null;
    outsideTempC: number | null;
    speedMaxKmh: number | null;
  }>;
  charges: Array<{
    startedAt: string;
    location: string | null;
    energyAddedKwh: number;
    energyUsedKwh: number | null;
    durationMin: number | null;
    startLevel: number | null;
    endLevel: number | null;
    fast: boolean;
    /** Share off the roof, from the car's own power samples. null when uncomputable. */
    solarPct: number | null;
    solarWh: number | null;
  }>;
  /** Over every charge in the window, not just the twenty listed. */
  chargeTotals: { energyWh: number; solarWh: number; solarPct: number; count: number };
  updates: Array<{ installedAt: string; version: string }>;
  phantomDrain: {
    avgPctPerDay: number | null;
    worstGap: { start: string; end: string; pct: number } | null;
  };
  stats: {
    days: number;
    drivenKm: number;
    driveCount: number;
    energyUsedKwh: number;
    energyAddedKwh: number;
    avgConsumptionWhKm: number | null;
  };
  /**
   * What this driving would have cost in petrol, each drive priced at the published
   * average for the month it happened in.
   *
   * Null when no place, no price series or no comparison car has been configured — all of
   * which are "nobody told us". The alternative is a plausible number resting on a guessed
   * car in a guessed province, which looks identical on screen to one resting on facts.
   */
  gasComparison: {
    litres: number;
    gasCost: number;
    publishedKm: number;
    carriedForwardKm: number;
    carriedForwardCost: number;
    carriedFrom: string | null;
    unpricedKm: number;
    litresPer100Km: number;
    /** One sentence naming which distance was priced how. Rendered verbatim. */
    basis: string;
  } | null;
  lastChargeCurve: Array<{ t: string; powerKw: number; level: number }>;
}

export interface FuelSettings {
  geographies: Array<{ id: string; name: string }>;
  geography: string | null;
  litresPer100Km: number | null;
  months: number;
  newestMonth: string | null;
  newestCentsPerLitre: number | null;
  fetchedAt: string | null;
  source: string;
}

export interface UtilityUsageStatus {
  days: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Days the array produced while the meter recorded no export at all. */
  unmeteredDays: number;
  source: string | null;
}

export interface UtilityImportPreview {
  /** Null when the columns were not recognised — then `headers` is what you map. */
  mapping: { date: number; imported: number; exported: number; net?: number } | null;
  headers: string[];
  headerRow: number | null;
  readings: Array<{ date: string; importedKwh: number; exportedKwh: number }>;
  problems: string[];
  unmetered: Array<{ date: string; producedKwh: number }>;
  unmeteredNote: string | null;
  /** Present only on a committed import. */
  stored?: number;
}

export const fetchUtilityUsage = (): Promise<UtilityUsageStatus> => getJson('/api/utility-usage');

/**
 * Send a usage export to be read.
 *
 * `commit: false` reads it and reports what it found without storing anything, which is
 * the default the UI uses — a column mapped the wrong way round is only noticeable while
 * the file is still in front of you.
 */
export const importUtilityUsage = async (
  file: File,
  options: { commit?: boolean; mapping?: { date: number; imported: number; exported: number } } = {},
): Promise<UtilityImportPreview> => {
  const query = new URLSearchParams({ filename: file.name });
  if (options.commit) query.set('commit', 'true');
  if (options.mapping) query.set('mapping', JSON.stringify(options.mapping));
  const response = await fetch(`/api/utility-usage?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: await file.arrayBuffer(),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new Error((problem as { message?: string })?.message ?? `import → HTTP ${response.status}`);
  }
  return (await response.json()) as UtilityImportPreview;
};

export const fetchFuelSettings = (): Promise<FuelSettings> => getJson('/api/vehicle/fuel');

export const saveFuelSettings = async (
  body: { geography?: string; litresPer100Km?: number },
): Promise<FuelSettings> => {
  const response = await fetch('/api/vehicle/fuel', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new Error((problem as { message?: string })?.message ?? `fuel → HTTP ${response.status}`);
  }
  return (await response.json()) as FuelSettings;
};

export const fetchVehicleDetails = (days: number): Promise<{ details: VehicleDetails | null }> =>
  getJson(`/api/charger/vehicle?days=${days}`);

export interface SetupDevices {
  dtuHost: string | null;
  chargerHost: string | null;
  suggestedSubnet: string;
  vendors: Array<{ id: string; name: string }>;
}

export interface ScanResult {
  subnet: string;
  dtus: Array<{ host: string; vendor: string; serialNumber: string; inverterCount: number; pvCount: number }>;
  chargers: Array<{ host: string; vendor: string; gridVoltage: number }>;
  scannedHosts: number;
}

export interface HomeDevice {
  id: number;
  vendor: string;
  kind: string;
  name: string;
  host: string;
  room: string | null;
  critical: boolean;
  enabled: boolean;
  config: string | null;
  /**
   * `"mains"` when this meter is clamped on the service entrance, else null.
   *
   * The one designation that changes what a device's readings mean elsewhere: with it,
   * self-consumption becomes production minus what actually left the property instead of
   * a percentage typed into Settings.
   */
  role: string | null;
  capabilities: string[];
  state: {
    reachable: boolean;
    on?: boolean;
    /** Null on hardware with no metering — "unknown", never "zero". */
    powerW?: number | null;
    energyWh?: number | null;
    temperatureC?: number | null;
    setpointC?: number | null;
    heating?: boolean;
    rssi?: number | null;
    updatedAt: string;
  } | null;
}

export interface DiscoveredHomeDevice {
  vendor: string;
  kind: string;
  name: string;
  host: string;
  port?: number;
  hardwareId?: string;
  model?: string;
  paired?: boolean;
  adopted: boolean;
  /** Visible on the network, but not controllable without a vendor-cloud credential. */
  needsCloudKey?: boolean;
}

/**
 * Named apart from the setup-scan `ScanResult` above deliberately.
 *
 * Both were called `ScanResult`, and TypeScript merges same-name interfaces rather
 * than rejecting them — so the single merged type carried every field of both, and
 * a home-device scan result appeared to have `.dtus` while a setup scan appeared to
 * have `.devices`. Either one would have compiled and thrown at runtime.
 */
export interface HomeScanResult {
  devices: DiscoveredHomeDevice[];
  /** What the scan can recognise — so "none found" can be told apart from "never looked". */
  lookedFor: string[];
  /** Which subnets were covered — the other half of an honest "nothing found". */
  scanned?: string[];
}

export interface SubnetSuggestion {
  subnet: string;
  reason: string;
  /** known = a device lives there · likely = our own network · guess = a default. */
  confidence: 'known' | 'likely' | 'guess';
}

export const fetchSubnetSuggestions = (): Promise<SubnetSuggestion[]> =>
  getJson('/api/devices/subnets');

/** How far to trust an estimated figure. Absent when the energy was measured. */
export type Confidence = 'good' | 'fair' | 'rough';

export type LoadType = 'resistive' | 'motor' | 'variable' | 'electronic';

export interface DeviceLoad {
  ratedW?: number | null;
  loadLabel?: string | null;
  loadType?: LoadType | null;
}

export interface ChannelUsage {
  channel: number;
  /** Owner-supplied name for what this circuit feeds ("Dryer", "Water heater"). */
  label: string;
  energyKwh: number;
  returnedKwh?: number;
  sharePct: number;
  /**
   * Present when != 1. A CT on one leg of a 240 V circuit reads half, so the figure
   * shown has been corrected — and the UI says so rather than passing it off as raw.
   */
  voltageMultiplier?: number;
}

export interface DeviceUsage {
  deviceId: number;
  name: string;
  kind: string;
  onHoursPerDay: number;
  energyKwh: number | null;
  metered: boolean;
  /** Per-circuit breakdown on a multi-channel meter. */
  channels?: ChannelUsage[];
  /** True when energyKwh came from on-time x rated watts rather than a meter. */
  estimated?: boolean;
  confidence?: Confidence;
  loadLabel?: string;
  observations: string[];
}

export interface ChannelConfig {
  channel: number;
  label?: string;
  ratedW?: number;
  /** 1 = the CT sees the whole circuit; 2 = a 240 V two-pole leg; 3 = three-phase. */
  voltageMultiplier?: number;
}

export const setDeviceChannels = async (
  id: number,
  channels: ChannelConfig[],
): Promise<void> => {
  const response = await fetch(`/api/devices/${id}/channels`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message ?? `channels → HTTP ${response.status}`);
  }
};

export const setDeviceLoad = async (id: number, load: DeviceLoad): Promise<void> => {
  const response = await fetch(`/api/devices/${id}/load`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(load),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message ?? `load → HTTP ${response.status}`);
  }
};

/** Declare a meter as the service-entrance clamp, or clear it. Exclusive server-side. */
export const setDeviceRole = async (id: number, role: 'mains' | null): Promise<void> => {
  const response = await fetch(`/api/devices/${id}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message ?? `role → HTTP ${response.status}`);
  }
};

export const fetchHomeDevices = (): Promise<HomeDevice[]> => getJson('/api/devices');
export const fetchDeviceUsage = (days: number): Promise<DeviceUsage[]> =>
  getJson(`/api/devices/usage?days=${days}`);
export const scanHomeDevices = async (subnet: string): Promise<HomeScanResult> => {
  const response = await fetch(`/api/devices/scan?subnet=${encodeURIComponent(subnet)}`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(`scan → HTTP ${response.status}`);
  return (await response.json()) as HomeScanResult;
};
/**
 * Adopt a discovered device.
 *
 * Returns the stored row rather than void: the endpoint always sent it back, and the
 * add-device flow needs the id to ask what an unmetered device runs immediately after
 * adopting it — which is the one moment someone will answer.
 */
export const adoptHomeDevice = async (
  device: DiscoveredHomeDevice,
): Promise<{ id: number; name: string }> => {
  const response = await fetch('/api/devices/adopt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(device),
  });
  if (!response.ok) throw new Error(`adopt → HTTP ${response.status}`);
  return (await response.json()) as { id: number; name: string };
};
export const updateHomeDevice = (
  id: number,
  patch: { name?: string; room?: string | null; critical?: boolean; enabled?: boolean },
): Promise<object> => putJson(`/api/devices/${id}`, patch);
export const commandHomeDevice = async (
  id: number,
  action: string,
  value?: number,
): Promise<void> => {
  const response = await fetch(`/api/devices/${id}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, value }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message ?? `command → HTTP ${response.status}`);
  }
};
export interface DeviceSchedule {
  id: number;
  deviceId: number;
  action: string;
  trigger: string;
  timeOfDay: string | null;
  offsetMin: number;
  value: number | null;
  enabled: boolean;
  lastRunDate: string | null;
}

export const fetchSchedules = (deviceId: number): Promise<DeviceSchedule[]> =>
  getJson(`/api/devices/${deviceId}/schedules`);
export const addSchedule = async (
  deviceId: number,
  schedule: { action: string; trigger: string; timeOfDay?: string; offsetMin?: number; value?: number },
): Promise<void> => {
  const response = await fetch(`/api/devices/${deviceId}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedule),
  });
  if (!response.ok) throw new Error(`schedule → HTTP ${response.status}`);
};
export const removeSchedule = async (scheduleId: number): Promise<void> => {
  await fetch(`/api/devices/schedules/${scheduleId}`, { method: 'DELETE' });
};

export const pairHomeDevice = async (id: number, pin: string): Promise<void> => {
  const response = await fetch(`/api/devices/${id}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message ?? `pair → HTTP ${response.status}`);
  }
};

export interface Milestones {
  daysCollecting: number;
  firstDate: string | null;
  lifetimeWh: number;
  lifetimeCo2Kg: number;
  avgDayWh: number;
  bestDay: { date: string; wh: number } | null;
  bestMonth: { month: string; wh: number } | null;
  bestWeek: { endDate: string; wh: number } | null;
  peakPowerW: number;
  peakPowerAt: string | null;
  todayIsRecord: boolean;
  producingStreak: number;
  nextMwh: { targetMwh: number; pct: number } | null;
}

export const fetchRecords = (): Promise<Milestones> => getJson('/api/records');

export interface Battery {
  present: boolean;
  name?: string;
  model?: string;
  capacityKwh?: number;
  soc?: number;
  powerW?: number;
  reservePct?: number;
  todayChargedKwh?: number;
  todayDischargedKwh?: number;
  cycles?: number;
  roundTripPct?: number;
  series?: Array<{ t: string; soc: number; powerW: number }>;
  /** Present only in demo mode when a recorded device is selected. */
  fixture?: { id: string; device: string; provenance: Provenance; source: string };
  /** The device answered but nothing in the payload was recognised. */
  unparsed?: boolean;
}

export const fetchBattery = (): Promise<Battery> => {
  const fixture = isDemoMode() ? demoFixture() : null;
  return getJson(`/api/battery${fixture ? `?fixture=${encodeURIComponent(fixture)}` : ''}`);
};

/**
 * How much a fixture's numbers can be trusted. Only `captured` says anything about
 * whether the integration actually works against real hardware — the others describe
 * how well we match documentation, which is a different and weaker claim.
 */
export type Provenance = 'captured' | 'documented' | 'synthetic';

export interface DemoFixtureInfo {
  id: string;
  vendor: string;
  device: string;
  kind: string;
  summary: string;
  provenance: Provenance;
  source: string;
}

/**
 * Fetched straight from the demo route rather than through getJson, because demoize()
 * rewrites the first `/api/` and would turn this into `/api/demo/demo/fixtures`.
 */
export const fetchFixtures = async (): Promise<DemoFixtureInfo[]> => {
  const response = await fetch('/api/demo/fixtures');
  if (!response.ok) throw new Error(`fixtures → HTTP ${response.status}`);
  return (await response.json()) as DemoFixtureInfo[];
};

export interface EcoFlowDevice {
  sn: string;
  deviceName?: string;
  productName?: string;
  online?: number;
}
export const listEcoFlowDevices = async (
  accessKey: string,
  secretKey: string,
): Promise<EcoFlowDevice[]> => {
  const response = await fetch('/api/battery/ecoflow/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessKey, secretKey }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message ?? `HTTP ${response.status}`);
  }
  return ((await response.json()) as { devices: EcoFlowDevice[] }).devices;
};
export interface BatteryVendorField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

export interface BatteryVendorInfo {
  id: string;
  name: string;
  connection: 'local' | 'cloud';
  /** How well we know it works: implemented against a spec, or proven on hardware. */
  confidence: 'verified' | 'documented';
  summary: string;
  setupHint: string;
  fields: BatteryVendorField[];
}

export interface BatteryConfig {
  vendor: string | null;
  configured: boolean;
  /** Non-secret values, so a form can be reopened showing what was entered. */
  values: Record<string, string>;
  /** Which secrets are stored — never the secrets themselves. */
  secretsSet: Record<string, boolean>;
  /** Set when a battery is configured but the last read failed. */
  error: string | null;
}

export const fetchBatteryVendors = (): Promise<BatteryVendorInfo[]> =>
  getJson('/api/battery/vendors');

export const fetchBatteryConfig = (): Promise<BatteryConfig> => getJson('/api/battery/config');

export const testBatteryConfig = (
  vendor: string,
  config: Record<string, string>,
): Promise<{ ok: boolean; error?: string; soc?: number }> =>
  postJson('/api/battery/test', { vendor, config });

export const saveBatteryConfig = async (
  vendor: string,
  config: Record<string, string>,
): Promise<void> => {
  const response = await fetch('/api/battery/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor, config }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
};

export const clearBatteryConfig = async (): Promise<void> => {
  const response = await fetch('/api/battery/config', { method: 'DELETE' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
};

export interface PanelInsight {
  portId: number;
  panel: string;
  deficitPct: number;
  lostWhPerDay: number;
  diagnosis: string;
  pattern: 'shading' | 'all-day';
}

export const fetchPanelInsights = (days: number): Promise<PanelInsight[]> =>
  getJson(`/api/analytics/panels?days=${days}`);

export const fetchNotifications = (): Promise<{ webhook: string | null }> =>
  getJson('/api/notifications');
export const saveNotifications = (webhook: string): Promise<{ webhook: string | null }> =>
  putJson('/api/notifications', { webhook });
export const testNotification = async (): Promise<void> => {
  const response = await fetch('/api/notifications/test', { method: 'POST' });
  if (!response.ok) throw new Error(`test → HTTP ${response.status}`);
};

export interface OnboardingStatus {
  complete: boolean;
  solar: { configured: boolean; host: string | null; inverterCount: number | null };
  charger: { configured: boolean; host: string | null };
  devices: { count: number };
  preferences: { priceSet: boolean; notifySet: boolean };
  suggestedSubnet: string;
  subnetSuggestions: string[];
}

export const fetchOnboarding = (): Promise<OnboardingStatus> => getJson('/api/onboarding/status');
export const completeOnboarding = async (): Promise<void> => {
  await fetch('/api/onboarding/complete', { method: 'POST' });
};
export const resetOnboarding = async (): Promise<void> => {
  await fetch('/api/onboarding/reset', { method: 'POST' });
};

export const fetchSetupDevices = (): Promise<SetupDevices> => getJson('/api/setup/devices');
export const scanForDevices = async (subnet: string): Promise<ScanResult> => {
  const response = await fetch(`/api/setup/scan?subnet=${encodeURIComponent(subnet)}`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(`scan → HTTP ${response.status}`);
  return (await response.json()) as ScanResult;
};
export const saveDevices = (devices: {
  dtuHost?: string;
  chargerHost?: string;
  solarVendor?: string;
}): Promise<SetupDevices> => putJson('/api/setup/devices', devices);

export interface ChargeSession {
  startedAt: string;
  endedAt: string;
  energyWh: number;
  solarWh: number;
  solarPct: number;
  peakW: number;
}

export interface ChargeSessions {
  sessions: ChargeSession[];
  totals: { energyWh: number; solarWh: number; solarPct: number };
}

export const fetchChargeSessions = (days: number): Promise<ChargeSessions> =>
  getJson(`/api/charger/sessions?days=${days}`);

/** Poll a fetcher on an interval; keeps the last good value on transient errors. */
/**
 * @param key Anything the fetcher reads that can change — a selected range, a grouping.
 *
 * Without it, changing that thing did nothing until the next tick. The fetcher is held in
 * a ref so the interval never gets torn down and rebuilt, which also means a new closure
 * is never *called*: pick "90 d" on Trends and the chart kept showing 30 days for up to
 * five minutes, looking like a dead button. Passing the value here re-runs the effect and
 * fetches at once.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  key?: string | number,
): { data: T | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback((): void => {
    fetcherRef
      .current()
      .then(setData)
      .catch(() => {
        /* keep last good value */
      });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, refresh, key]);

  return { data, refresh };
}

// ---------------------------------------------------------------------------
// Updates
//
// The app checks a release feed and shows what it finds; it never downloads or
// installs anything. A root-owned systemd timer does that, and the only thing the
// app can tell it is "the user asked for this exact version".
// ---------------------------------------------------------------------------

export interface BuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
  stamped: boolean;
}

export interface UpdateState {
  startedAt: string | null;
  finishedAt: string | null;
  fromVersion: string | null;
  fromCommit: string | null;
  toVersion: string | null;
  result: 'ok' | 'rolled-back' | 'failed' | 'refused' | null;
  message: string | null;
  checkedAt: string | null;
}

/** Cheap enough to poll: no database work behind it, unlike /api/status. */
export const fetchBuild = (): Promise<BuildInfo> => getJson('/api/build');

export type Grouping = 'day' | 'month' | 'year';

export interface ProductionBucket {
  key: string;
  label: string;
  energyWh: number;
  daysWithData: number;
  daysInPeriod: number;
  /** False for the period in progress and for any the app only partly recorded. */
  complete: boolean;
}

export interface ProductionBuckets {
  grouping: Grouping;
  buckets: ProductionBucket[];
  summary: string;
}

export const fetchProductionBuckets = (grouping: Grouping, days?: number): Promise<ProductionBuckets> =>
  getJson(`/api/history/production?grouping=${grouping}${days ? `&days=${days}` : ''}`);

export interface UpdateStatus {
  current: BuildInfo;
  channel: 'off' | 'stable' | 'prerelease';
  channels: Array<{ id: 'off' | 'stable' | 'prerelease'; label: string; detail: string }>;
  apply: boolean;
  hour: number;
  timeZone: string;
  arch: string;
  source: { kind: 'dir' | 'url' | 'none'; location: string | null; describe: string };
  configured: boolean;
  available: {
    version: string;
    publishedAt: string | null;
    notesUrl: string | null;
    notes: string | null;
    sizeBytes: number | null;
  } | null;
  reason: string;
  blocked: boolean;
  checkedAt: string | null;
  checkError: string | null;
  lastAttempt: UpdateState | null;
  lastAttemptText: string | null;
  pending: string | null;
}

export const fetchUpdateStatus = (): Promise<UpdateStatus> => getJson('/api/updates');
export const checkForUpdates = (): Promise<UpdateStatus> => postJson('/api/updates/check', {});
export const saveUpdatePolicy = (input: {
  channel?: string;
  apply?: boolean;
  hour?: number;
}): Promise<UpdateStatus> => putJson('/api/updates/policy', input);
export const requestUpdateInstall = (version: string): Promise<{ ok: boolean; message: string }> =>
  postJson('/api/updates/install', { version });
export const cancelUpdateInstall = async (): Promise<void> => {
  await fetch('/api/updates/install', { method: 'DELETE' });
};

// ---------------------------------------------------------------------------
// Vehicle (TeslaMate)
//
// The password is never returned — `passwordSet` says whether one is stored, and
// sending a blank one on save keeps whatever is there rather than clearing it.
// ---------------------------------------------------------------------------

export interface TeslamateFields {
  host: string;
  port: number;
  user: string;
  database: string;
}

export interface VehicleConfig {
  configured: boolean;
  describe: string | null;
  fromEnvironment: boolean;
  config: TeslamateFields;
  passwordSet: boolean;
}

export interface VehicleTestResult {
  ok: boolean;
  message: string;
  car?: string;
  saved?: boolean;
}

export const fetchVehicleConfig = (): Promise<VehicleConfig> => getJson('/api/vehicle/config');
export const testVehicleConfig = (
  input: Partial<TeslamateFields> & { password?: string },
): Promise<VehicleTestResult> => postJson('/api/vehicle/test', input);
export const saveVehicleConfig = (
  input: Partial<TeslamateFields> & { password?: string },
): Promise<VehicleTestResult> => putJson('/api/vehicle/config', input);
export const disconnectVehicle = async (): Promise<void> => {
  await fetch('/api/vehicle/config', { method: 'DELETE' });
};

export interface HomeLocation {
  latitude: number;
  longitude: number;
  radiusM: number;
}

/** Whether the car's home follows the array's location or holds its own. */
export type HomeMode = 'site' | 'manual';

export interface SiteLocation {
  latitude: number;
  longitude: number;
}

export interface HomeSettings {
  home: HomeLocation | null;
  mode: HomeMode;
  /** The array's location, so the form can show what following it would mean. */
  site: SiteLocation | null;
  /** Where the car is now, so the form can be filled from the driveway. */
  carPosition: { latitude: number; longitude: number; at: string } | null;
  defaultRadiusM: number;
}

export const fetchHome = (): Promise<HomeSettings> => getJson('/api/vehicle/home');
export const saveHome = (home: HomeLocation): Promise<{ ok: boolean; home: HomeLocation }> =>
  putJson('/api/vehicle/home', home);
/** Point home at the site instead. Sends no coordinates — see the controller for why. */
export const followSiteAtHome = (radiusM: number): Promise<{ ok: boolean }> =>
  putJson('/api/vehicle/home', { mode: 'site', radiusM });
export const clearHome = async (): Promise<void> => {
  await fetch('/api/vehicle/home', { method: 'DELETE' });
};

// ---------------------------------------------------------------------------
// Where the array is
//
// Drives the forecast, sunrise and sunset, expected-vs-actual, the cloud panel and
// which radar source is used. Null means unset, and every one of those features
// stays off rather than describing somewhere else.

export const fetchSiteLocation = (): Promise<{ location: SiteLocation | null }> =>
  getJson('/api/weather/location');
export const saveSiteLocation = (location: SiteLocation): Promise<{ ok: boolean }> =>
  putJson('/api/weather/location', location);

// ---------------------------------------------------------------------------
// Radar
//
// Off by default, and fetched by the server rather than the browser: a tile pulled
// client-side would put the household's rough position into somebody else's request
// log on every page load.

export interface RadarStatus {
  enabled: boolean;
  /** Null when no location is set — the picture needs somewhere to centre on. */
  source: 'eccc' | 'rainviewer' | null;
  updatedAt: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// What the machine has had to do to keep itself running
//
// The Pi repairs its own network. Every repair is a success, which is precisely why
// it has to be visible — a box quietly rebooting nightly looks identical to a healthy
// one from in here.

export interface RecoveryEvent {
  at: string;
  action: string;
  detail: string;
}

export interface RecoverySummary {
  events: RecoveryEvent[];
  repairs: number;
  reboots: number;
  since: string | null;
  verdict: string | null;
}

export const fetchRecovery = (): Promise<RecoverySummary> => getJson('/api/system/recovery');

// ---------------------------------------------------------------------------
// Filling a hole in the power history from a vendor export
//
// Previews by default. This writes into the only copy of the measurement history,
// and an import that parses and saves in one step gives nobody a moment to notice
// the file covers the wrong day.

export interface ImportDay {
  date: string;
  rows: number;
  /** What this import would write, against what the gateway already recorded. */
  importedPeakWh: number;
  recordedPeakWh: number;
}

export interface ImportSummary {
  dates: string[];
  inserted: number;
  /** Refused because a real reading already covers that moment. */
  covered: number;
  rejected: number;
  perDay: ImportDay[];
  from: string | null;
  to: string | null;
  applied: boolean;
}

export const previewCloudImport = (text: string, date?: string): Promise<ImportSummary> =>
  postText(`/api/readings/cloud-import${date ? `?date=${date}` : ''}`, text);

export const applyCloudImport = (text: string, date?: string): Promise<ImportSummary> =>
  postText(`/api/readings/cloud-import?commit=true${date ? `&date=${date}` : ''}`, text);

export const fetchCloudImports = (): Promise<Array<{ localDate: string; rows: number }>> =>
  getJson('/api/readings/cloud-import');

export const undoCloudImport = async (date: string): Promise<{ removed: number }> => {
  const response = await fetch(`/api/readings/cloud-import?date=${date}`, { method: 'DELETE' });
  if (!response.ok) throw new Error((await response.json()).message ?? 'Could not undo');
  return response.json();
};

/** A polyline in the picture's own coordinates: 0–1 across, 0–1 down. */
export interface GeographyLine {
  kind: 'coast' | 'border' | 'lake' | 'country';
  /** Flat [x, y, x, y, …]. */
  points: number[];
}

export const fetchRadarGeography = (): Promise<{ lines: GeographyLine[] }> =>
  getJson('/api/radar/geography');

export const fetchRadarStatus = (): Promise<RadarStatus> => getJson('/api/radar');
export const setRadarEnabled = (enabled: boolean): Promise<RadarStatus> =>
  putJson('/api/radar', { enabled });

/** Radar composites refresh every six to ten minutes. */
export const RADAR_CACHE_MS = 5 * 60_000;

/**
 * The image URL, stable within each cache window and new after it.
 *
 * The server caches for five minutes and says so in Cache-Control, so a fixed URL would
 * be served out of the browser cache indefinitely and the picture would never move. A
 * bucketed timestamp changes exactly when there is something new to fetch — asking on
 * every render instead would defeat the server's cache and the whole point of it.
 */
export const radarImageUrl = (now = Date.now()): string =>
  `/api/radar/image.png?t=${Math.floor(now / RADAR_CACHE_MS)}`;

// ---------------------------------------------------------------------------
// Banked export credits
//
// The balance is entered from a bill, not measured — this app sees production,
// not what crosses the meter. `basis` says whether a projection was possible and
// why not when it wasn't.
// ---------------------------------------------------------------------------

export interface CreditBankStatus {
  balanceKwh: number | null;
  readAt: string | null;
  expiresAt: string;
  daysRemaining: number;
  projectedKwh: number | null;
  atRiskKwh: number | null;
  atRiskValue: number | null;
  basis: 'none' | 'single-reading' | 'too-short' | 'crosses-unseen-winter' | 'trend';
  message: string;
  redeemRatePerKwh: number;
  readings: Array<{ id: number; readAt: string; balanceKwh: number; note: string | null }>;
  /**
   * The same bank counted from imported meter data, when there is any.
   *
   * Null on installs with no usage export — and on any error deriving it, since the typed
   * balances are the older half of this endpoint and must not vanish with the newer one.
   */
  derived: {
    balanceKwh: number | null;
    netKwh: number;
    throughDate: string | null;
    missingDays: number;
    emptied: boolean;
    /** Produced on days the meter recorded no export. Not in the bank, and never will be. */
    neverCreditedKwh: number;
    basis: 'derived' | 'change-only' | 'none';
    summary: string;
  } | null;
  /**
   * What is on track to be forfeited at the expiry date, and what draw would absorb it.
   *
   * Advisory. The app never commands a charger off this — drawing power costs money when
   * a projection is wrong, so the decision stays with the owner.
   */
  dump: {
    atRiskKwh: number | null;
    atRiskValue: number | null;
    daysRemaining: number;
    dailyNetKwh: number | null;
    dumpKwhPerDay: number | null;
    dumpHoursPerDay: number | null;
    actionable: boolean;
    reason: string;
  } | null;
}

export const fetchCreditBank = (): Promise<CreditBankStatus> => getJson('/api/credits');
export const addCreditReading = (input: {
  readAt: string;
  balanceKwh: number;
  note?: string;
}): Promise<CreditBankStatus> => postJson('/api/credits', input);
export const removeCreditReading = async (id: number): Promise<CreditBankStatus> => {
  const response = await fetch(`/api/credits/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as CreditBankStatus;
};

/**
 * The one outbound integration.
 *
 * No `apiKey` field, deliberately: the server never sends it back, in any form. The UI
 * needs to know whether one is stored, which `configured` answers without carrying the
 * secret through a response body, a proxy log and a browser cache on the way.
 */
export interface PvoutputStatus {
  enabled: boolean;
  configured: boolean;
  systemId: string | null;
  lastUploadAt: string | null;
  lastError: string | null;
  rateRemaining: number | null;
}

export const fetchPvoutput = (): Promise<PvoutputStatus> => getJson('/api/pvoutput');
export const savePvoutput = (
  input: { enabled?: boolean; apiKey?: string; systemId?: string },
): Promise<PvoutputStatus> => putJson('/api/pvoutput', input);
export const testPvoutput = (): Promise<{ ok: boolean; message: string }> =>
  postJson('/api/pvoutput/test', {});
export const forgetPvoutput = async (): Promise<PvoutputStatus> => {
  const response = await fetch('/api/pvoutput', { method: 'DELETE' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<PvoutputStatus>;
};

/**
 * One notification the app raised.
 *
 * `deliveredAt` and `error` both null means there was nowhere to send it — the normal state
 * of an install with no webhook, and not a failure.
 */
export interface NotificationRecord {
  id: number;
  raisedAt: string;
  title: string | null;
  body: string;
  deliveredAt: string | null;
  error: string | null;
}

export const fetchNotificationHistory = (limit = 30): Promise<NotificationRecord[]> =>
  getJson(`/api/notifications/history?limit=${limit}`);

/**
 * The `.local` name this install answers to.
 *
 * `address` is carried alongside deliberately: renaming is the one setting that can cut
 * off the browser making the request, so there is always an IP to fall back to on screen.
 */
export interface MdnsStatus {
  hostname: string;
  url: string | null;
  running: boolean;
  source: 'setting' | 'environment' | 'default';
  address: string | null;
  port: number;
  error: string | null;
}

export const fetchMdns = (): Promise<MdnsStatus> => getJson('/api/mdns');
export const saveMdns = (hostname: string): Promise<MdnsStatus> =>
  putJson('/api/mdns', { hostname });

/** A price that was in effect from a date, so history keeps what it was actually worth. */
export interface RateEntry {
  id: number;
  effectiveFrom: string;
  pricePerKwh: number;
  hstRate: number;
  priceIncludesTax: boolean;
  note: string | null;
}

export const fetchRates = (): Promise<RateEntry[]> => getJson('/api/rates');
export const addRate = (input: {
  effectiveFrom: string;
  pricePerKwh: number;
  hstRate: number;
  priceIncludesTax: boolean;
}): Promise<RateEntry[]> => postJson('/api/rates', input);
export const removeRate = async (id: number): Promise<RateEntry[]> => {
  const response = await fetch(`/api/rates/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<RateEntry[]>;
};
