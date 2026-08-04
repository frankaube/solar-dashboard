/**
 * Reading evcc's state.
 *
 * evcc is a self-hosted Go application that has already solved the problem this app
 * would otherwise take a year to solve badly: sixteen-odd vehicle brands, dozens of
 * chargers, OCPP, Modbus. Rather than reimplement forty integrations, this reads what
 * evcc already knows and maps it onto our own shapes.
 *
 * That makes this app the dashboard and evcc the integration layer, which is the right
 * division of labour — and it is why the alternative (a cloud OAuth client per car
 * manufacturer) is explicitly not on the roadmap. See docs/ev-support-deepdive.md.
 *
 * Parsing lives here as pure functions because the interesting failures are all shape
 * failures: a field renamed upstream, a response wrapper that came and went, a loadpoint
 * with no vehicle attached. None of those need a network to reproduce.
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
  /**
   * Share of this session that came from solar, as evcc measured it.
   *
   * The most valuable field in the whole payload for this app. Self-consumption here is
   * otherwise an owner's estimate, because only a metering device can see energy going
   * into the house rather than out to the grid — and evcc, sitting between the array and
   * the car, is exactly such a device.
   */
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

/**
 * Unwrap the response body.
 *
 * evcc used to wrap everything in `{"result": {...}}` and dropped it in a breaking
 * change. Accepting both costs one line and means the adapter does not care which side
 * of that upgrade an owner is on — the alternative is an integration that breaks on
 * somebody else's release schedule.
 */
export function unwrap(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const obj = body as Record<string, unknown>;
  const result = obj.result;
  return result && typeof result === 'object' ? (result as Record<string, unknown>) : obj;
}

export function parseLoadpoint(raw: unknown, index: number): EvccLoadpoint {
  const lp = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  /*
    evcc reports session energy in kWh and this app works in Wh everywhere. Converting
    at the boundary rather than downstream keeps the "everything internal is Wh" rule
    that the rest of the codebase depends on.
  */
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
  /*
    evcc numbers loadpoints from 1 in its MQTT topics and its own UI. Matching that here
    means a support conversation about "loadpoint 2" refers to the same thing in both
    places.
  */
  const loadpoints = rawLoadpoints.map((lp, i) => parseLoadpoint(lp, i + 1));

  /*
    The vehicle list has been a map keyed by internal name and an array across versions.
    Both are handled because neither is unreasonable and guessing wrong shows up as a
    vehicle list that is silently empty.
  */
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

/**
 * The loadpoint worth showing as "the charger", when there are several.
 *
 * Prefers one that is actually charging, then one with a car plugged in, then the first.
 * A house with two charge points otherwise shows whichever evcc happened to list first,
 * which is the idle one about half the time.
 */
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
