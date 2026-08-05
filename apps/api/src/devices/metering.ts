/**
 * Unit normalisation for device energy readings.
 *
 * Every vendor here reports energy in a different unit, and several report it in
 * *different* units depending on firmware. Getting this wrong is silent — the number
 * still looks plausible on a chart — so the conversions live here with tests rather
 * than inline in each adapter. The shared model is always W and Wh.
 */

const WH_PER_KWH = 1000;
const MINUTES_PER_HOUR = 60;
const MILLI = 1000;

/** Shelly Gen1 `meters[].total` is watt-MINUTES, not watt-hours. */
export function wattMinutesToWh(wattMinutes: number): number {
  return wattMinutes / MINUTES_PER_HOUR;
}

export function kwhToWh(kwh: number): number {
  return kwh * WH_PER_KWH;
}

export interface KasaEmeter {
  // Newer firmware: real units.
  power?: number; // W
  voltage?: number; // V
  current?: number; // A
  total?: number; // kWh
  // Older firmware: milli-units, and total in Wh (not kWh).
  power_mw?: number;
  voltage_mv?: number;
  current_ma?: number;
  total_wh?: number;
}

export interface NormalisedEmeter {
  powerW: number | null;
  energyWh: number | null;
  voltageV: number | null;
  currentA: number | null;
}

/**
 * Kasa exposes two firmware-dependent key sets, and they are NOT the same scale —
 * note that the old `total_wh` is already watt-hours while the new `total` is
 * kilowatt-hours, so the naive "old keys are just milli-units" rule breaks on
 * exactly the field that accumulates.
 */
export function normaliseKasaEmeter(e: KasaEmeter | undefined): NormalisedEmeter {
  if (!e) return { powerW: null, energyWh: null, voltageV: null, currentA: null };
  const pick = (real: number | undefined, milli: number | undefined): number | null => {
    if (real !== undefined) return real;
    if (milli !== undefined) return milli / MILLI;
    return null;
  };
  const energyWh =
    e.total !== undefined ? kwhToWh(e.total) : e.total_wh !== undefined ? e.total_wh : null;
  return {
    powerW: pick(e.power, e.power_mw),
    energyWh,
    voltageV: pick(e.voltage, e.voltage_mv),
    currentA: pick(e.current, e.current_ma),
  };
}

/** True if a Kasa sysinfo `feature` string advertises the energy monitor. */
export function kasaHasEmeter(feature: string | undefined): boolean {
  return (feature ?? '').split(':').includes('ENE');
}

export interface EsphomeEntity {
  id: string;
  domain: string;
  objectId: string;
  name: string;
  /** Formatted state, e.g. "412 W" — the unit lives here, not in a separate field. */
  state: string | null;
  value: number | null;
  on?: boolean;
  currentTemperatureC?: number;
  targetTemperatureC?: number;
  action?: string;
}

export interface EsphomeRoles {
  powerW: number | null;
  energyWh: number | null;
  temperatureC: number | null;
  rssi: number | null;
}

/** Trailing unit of a formatted ESPHome state ("412 W" -> "W"). Null when unitless. */
export function esphomeUnit(state: string | null): string | null {
  if (!state) return null;
  const match = state.match(/^-?[\d.]+\s*(.+)$/);
  return match ? match[1].trim() : null;
}

/**
 * Sensors we must NOT read as the device's own temperature or power. A mini split
 * bridge publishes a whole refrigeration circuit — outdoor air, coil, discharge,
 * suction — and picking one of those as "room temperature" would be wrong in a way
 * that still looks entirely plausible on a chart.
 */
const SECONDARY_TEMPERATURE = /outsid|outdoor|ambient|coil|discharg|suction|evap|coolant|target|setpoint/i;
const ROOM_TEMPERATURE = /room|indoor|inside|current|air temp/i;

/**
 * Map an ESPHome device's entities onto the shared model, using each entity's UNIT
 * as the primary signal and its name only to break ties.
 *
 * Unit-first is the important choice. Entity names are author-chosen in YAML and vary
 * per config, per language, per firmware fork — matching on them first would make the
 * adapter quietly wrong on anyone else's device. The unit is set by the sensor's
 * declared device class and is far more stable.
 *
 * `overrides` pins a role to a specific entity id when a device genuinely has several
 * plausible candidates, which is the escape hatch rather than us guessing harder.
 */
export function classifyEsphomeEntities(
  entities: EsphomeEntity[],
  overrides: Record<string, string>,
): EsphomeRoles {
  const pinned = (role: string): EsphomeEntity | undefined =>
    overrides[role] ? entities.find((e) => e.id === overrides[role]) : undefined;

  const withUnit = (units: string[]): EsphomeEntity[] =>
    entities.filter((e) => {
      const unit = esphomeUnit(e.state);
      return unit !== null && units.includes(unit) && e.value !== null;
    });

  const powerEntity =
    pinned('powerW') ??
    // Real power before apparent: VA on a nonlinear load like an inverter compressor
    // overstates what the meter actually bills.
    withUnit(['W', 'kW']).find((e) => !/apparent|reactive/i.test(e.name)) ??
    withUnit(['W', 'kW'])[0];
  const energyEntity =
    pinned('energyWh') ?? withUnit(['Wh', 'kWh']).find((e) => !/today|daily|session/i.test(e.name)) ??
    withUnit(['Wh', 'kWh'])[0];
  const temps = withUnit(['°C', '°F']);
  const temperatureEntity =
    pinned('temperatureC') ??
    temps.find((e) => ROOM_TEMPERATURE.test(e.name) && !SECONDARY_TEMPERATURE.test(e.name)) ??
    temps.find((e) => !SECONDARY_TEMPERATURE.test(e.name));
  const rssiEntity = pinned('rssi') ?? withUnit(['dBm'])[0];

  const scale = (e: EsphomeEntity | undefined, kiloUnits: string[]): number | null => {
    if (!e || e.value === null) return null;
    const unit = esphomeUnit(e.state);
    return unit !== null && kiloUnits.includes(unit) ? e.value * WH_PER_KWH : e.value;
  };

  return {
    powerW: scale(powerEntity, ['kW']),
    energyWh: scale(energyEntity, ['kWh']),
    temperatureC: toCelsius(temperatureEntity),
    rssi: rssiEntity?.value ?? null,
  };
}

function toCelsius(entity: EsphomeEntity | undefined): number | null {
  if (!entity || entity.value === null) return null;
  return esphomeUnit(entity.state) === '°F' ? ((entity.value - 32) * 5) / 9 : entity.value;
}

export interface RawChannelEnergy {
  channel: number;
  drawnWh: number;
  returnedWh: number;
  /** 1 when the CT sees the whole circuit; 2 for a 240 V two-pole leg; 3 for three-phase. */
  multiplier: number;
}

export interface CorrectedChannelEnergy extends RawChannelEnergy {
  sharePct: number;
}

/**
 * Scale each leg by its voltage multiplier and work out each one's share.
 *
 * The denominator is the subtle part. `deviceTotalWh` is the meter's own sum of its
 * legs, uncorrected — so once any leg is doubled it is no longer commensurable with
 * the corrected figures, and dividing by it reports a 240 V circuit at twice its real
 * share (a house of nothing but 240 V loads would sum to ~200%). When any correction
 * applies we therefore normalise against the corrected sum instead. With no
 * corrections we keep the device total, because that can legitimately exceed the sum
 * of legs on hardware whose total channel covers draw the legs don't.
 */
export function correctChannelEnergy(
  channels: RawChannelEnergy[],
  deviceTotalWh: number,
): CorrectedChannelEnergy[] {
  const scaled = channels.map((c) => ({
    ...c,
    drawnWh: c.drawnWh * c.multiplier,
    returnedWh: c.returnedWh * c.multiplier,
  }));
  const anyCorrected = scaled.some((c) => c.multiplier !== 1);
  const correctedSum = scaled.reduce((sum, c) => sum + c.drawnWh, 0);
  const denominator = anyCorrected
    ? correctedSum || 1
    : deviceTotalWh > 0
      ? deviceTotalWh
      : 1;
  return scaled.map((c) => ({ ...c, sharePct: Math.round((c.drawnWh / denominator) * 100) }));
}

export interface ShellyComponent {
  output?: boolean;
  apower?: number;
  act_power?: number;
  voltage?: number;
  current?: number;
  aenergy?: { total?: number };
  total_act_energy?: number;
  /** Energy returned to the grid — meters count it separately from energy drawn. */
  ret_aenergy?: { total?: number };
  total_act_ret_energy?: number;
  temperature?: { tC?: number };
}

/**
 * Gen2+ status is a bag of component keys and the metered value lives under a
 * different one per device class: `switch:N` on plugs and relays, `pm1:N` on power
 * monitors, `em1:N` on the independent single-phase channels a split-phase whole-home
 * meter uses, `em:N` on three-phase, `light:N` on metered dimmers. Reading only
 * `switch:0`/`pm1:0` meant an adopted Pro 3EM reported no power at all.
 */
export function pickShellyComponents(status: Record<string, unknown>): ShellyComponent[] {
  const keys = Object.keys(status).filter((k) =>
    /^(switch|pm1|em1|em|light|cover):\d+$/.test(k),
  );
  // Prefer dedicated meter channels when present — on a device that has both, the
  // em1/pm1 channels are the calibrated ones.
  const preferred = keys.filter((k) => /^(em1|em|pm1):/.test(k));
  const use = preferred.length ? preferred : keys;
  return use
    .sort()
    .map((k) => status[k])
    .filter((v): v is ShellyComponent => typeof v === 'object' && v !== null);
}

/** Sum the active power of every metered channel; null when none report it. */
export function shellyTotalPowerW(components: ShellyComponent[]): number | null {
  const values = components
    .map((c) => c.apower ?? c.act_power)
    .filter((v): v is number => typeof v === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

/** Sum cumulative energy across channels (already Wh on Gen2+); null when absent. */
export function shellyTotalEnergyWh(components: ShellyComponent[]): number | null {
  const values = components
    .map((c) => c.aenergy?.total ?? c.total_act_energy)
    .filter((v): v is number => typeof v === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

/** Cumulative energy returned to the grid, summed across channels. */
export function shellyTotalReturnedWh(components: ShellyComponent[]): number | null {
  const values = components
    .map((c) => c.ret_aenergy?.total ?? c.total_act_ret_energy)
    .filter((v): v is number => typeof v === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

/**
 * Per-leg breakdown for multi-channel hardware. Only meaningful when the device
 * has more than one measured channel — a single-channel plug returns none, so the
 * caller doesn't write redundant rows duplicating the device total.
 */
export function shellyChannels(
  components: ShellyComponent[],
): Array<{ channel: number; powerW: number | null; energyWh: number | null; energyReturnedWh: number | null }> {
  if (components.length < 2) return [];
  return components.map((c, i) => ({
    channel: i + 1, // channel 0 is the device total
    powerW: c.apower ?? c.act_power ?? null,
    energyWh: c.aenergy?.total ?? c.total_act_energy ?? null,
    energyReturnedWh: c.ret_aenergy?.total ?? c.total_act_ret_energy ?? null,
  }));
}
