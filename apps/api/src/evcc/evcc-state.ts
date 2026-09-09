/**
 * Reading evcc's state. evcc already covers sixteen-odd vehicle brands, dozens of chargers,
 * OCPP and Modbus, so this maps what it knows onto our shapes rather than reimplementing
 * forty integrations or an OAuth client per manufacturer. See docs/ev-support-deepdive.md.
 */

/** One charge point, in evcc's vocabulary. */
export interface EvccLoadpoint {
  index: number;
  title: string | null;
  connected: boolean;
  charging: boolean;
  chargePowerW: number;
  /** This session, in Wh. evcc reports kWh. */
  sessionEnergyWh: number | null;
  /** Share of the session that came from solar — measured by evcc, not estimated. */
  solarPercent: number | null;
  vehicleTitle: string | null;
  vehicleSoc: number | null;
  vehicleRangeKm: number | null;
  phasesActive: number | null;
  mode: string | null;
}

export interface EvccState {
  siteTitle: string | null;
  pvPowerW: number | null;
  homePowerW: number | null;
  batterySoc: number | null;
  loadpoints: EvccLoadpoint[];
  /** Vehicle titles evcc knows about, whether or not one is plugged in right now. */
  vehicleTitles: string[];
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** evcc dropped its `{"result": {...}}` wrapper in a breaking change; both shapes accepted. */
export function unwrap(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const obj = body as Record<string, unknown>;
  const result = obj.result;
  return result && typeof result === 'object' ? (result as Record<string, unknown>) : obj;
}

export function parseLoadpoint(raw: unknown, index: number): EvccLoadpoint {
  const lp = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // evcc reports session energy in kWh; everything internal to this app is Wh.
  const sessionKwh = num(lp.sessionEnergy) ?? num(lp.chargedEnergy);
  return {
    index,
    title: str(lp.title),
    connected: lp.connected === true,
    charging: lp.charging === true,
    chargePowerW: num(lp.chargePower) ?? 0,
    sessionEnergyWh: sessionKwh === null ? null : Math.round(sessionKwh * 1000),
    solarPercent: num(lp.sessionSolarPercentage),
    // vehicleTitle is the human name; vehicleName is evcc's internal id.
    vehicleTitle: str(lp.vehicleTitle) ?? str(lp.vehicleName),
    vehicleSoc: num(lp.vehicleSoc),
    vehicleRangeKm: num(lp.vehicleRange),
    phasesActive: num(lp.phasesActive),
    mode: str(lp.mode),
  };
}

export function parseState(body: unknown): EvccState {
  const root = unwrap(body);
  const rawLoadpoints = Array.isArray(root.loadpoints) ? root.loadpoints : [];
  // evcc numbers loadpoints from 1 in its MQTT topics and its own UI; match that.
  const loadpoints = rawLoadpoints.map((lp, i) => parseLoadpoint(lp, i + 1));

  // The vehicle list has been a map keyed by internal name and an array across versions.
  const titles: string[] = [];
  const vehicles = root.vehicles;
  if (Array.isArray(vehicles)) {
    for (const v of vehicles) {
      const title = str((v as Record<string, unknown>)?.title);
      if (title) titles.push(title);
    }
  } else if (vehicles && typeof vehicles === 'object') {
    for (const [key, v] of Object.entries(vehicles as Record<string, unknown>)) {
      titles.push(str((v as Record<string, unknown>)?.title) ?? key);
    }
  }

  const battery = root.battery;
  return {
    siteTitle: str(root.siteTitle),
    pvPowerW: num(root.pvPower),
    homePowerW: num(root.homePower),
    batterySoc:
      num(root.batterySoc) ??
      (battery && typeof battery === 'object'
        ? num((battery as Record<string, unknown>).soc)
        : null),
    loadpoints,
    vehicleTitles: titles,
  };
}

/** Prefers charging, then plugged in, then first; evcc's own order lands on the idle one. */
export function primaryLoadpoint(state: EvccState): EvccLoadpoint | null {
  return (
    state.loadpoints.find((lp) => lp.charging) ??
    state.loadpoints.find((lp) => lp.connected) ??
    state.loadpoints[0] ??
    null
  );
}

/** Solar energy delivered to vehicles this session, in Wh — measured, not estimated. */
export function solarChargedWh(state: EvccState): number | null {
  let total = 0;
  let measured = false;
  for (const lp of state.loadpoints) {
    if (lp.sessionEnergyWh === null || lp.solarPercent === null) continue;
    measured = true;
    total += (lp.sessionEnergyWh * lp.solarPercent) / 100;
  }
  return measured ? Math.round(total) : null;
}
