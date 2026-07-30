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

export interface ProductionAnalytics {
  wattsPerIrradiance: number | null;
  points: ExpectedActualPoint[];
  tomorrowForecastWh: number | null;
  chargeWindow: { start: string; end: string; estKwh: number; avgKw: number } | null;
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
  /** True when self-consumption came from your estimate rather than a meter. */
  selfConsumptionEstimated: boolean;
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
  }>;
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
  lastChargeCurve: Array<{ t: string; powerKw: number; level: number }>;
}

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
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
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
  }, [intervalMs, refresh]);

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
