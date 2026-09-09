/**
 * OVMS — an OBD2 dongle that reads the car's CAN bus and publishes each metric to its own
 * MQTT topic, one plain-text value per topic, no JSON. Every other EV needs a manufacturer
 * cloud account (docs/ev-support-deepdive.md).
 *   ovms/<username>/<vehicleid>/metric/v/b/soc       ->  "54.5"
 *   ovms/<username>/<vehicleid>/metric/v/c/charging  ->  "yes"
 */

export const OVMS_DEFAULT_PREFIX = 'ovms';

export interface OvmsVehicle {
  /** OVMS's own label for the car, from the topic. */
  vehicleId: string;
  soc: number | null;
  rangeEstKm: number | null
  odometerKm: number | null;
  charging: boolean | null;
  chargePowerW: number | null;
  batteryVoltage: number | null;
  batteryCurrent: number | null;
  updatedAt: Date | null;
}

export function emptyVehicle(vehicleId: string): OvmsVehicle {
  return {
    vehicleId,
    soc: null,
    rangeEstKm: null,
    odometerKm: null,
    charging: null,
    chargePowerW: null,
    batteryVoltage: null,
    batteryCurrent: null,
    updatedAt: null,
  };
}

/** The username differs per install, so the topic shape is matched positionally, not by name. */
export function parseOvmsTopic(
  prefix: string,
  topic: string,
): { vehicleId: string; metric: string } | null {
  const parts = topic.split('/');
  const head = prefix.split('/').filter(Boolean);
  for (let i = 0; i < head.length; i++) {
    if (parts[i] !== head[i]) return null;
  }
  // <prefix>/<username>/<vehicleid>/metric/<path...>
  const rest = parts.slice(head.length);
  if (rest.length < 4 || rest[2] !== 'metric') return null;
  const vehicleId = rest[1];
  const metric = rest.slice(3).join('/');
  return vehicleId && metric ? { vehicleId, metric } : null;
}

/** OVMS booleans are words: `v/c/charging` is "yes"/"no", and Boolean("no") is true. */
export function parseOvmsBool(payload: string): boolean | null {
  const v = payload.trim().toLowerCase();
  if (['yes', 'true', '1', 'on'].includes(v)) return true;
  if (['no', 'false', '0', 'off'].includes(v)) return false;
  return null;
}

function parseNum(payload: string): number | null {
  const n = Number(payload.trim());
  return Number.isFinite(n) ? n : null;
}

/** Returns a new object, so a caller can keep the previous reading on an unparseable payload. */
export function applyOvmsMetric(
  vehicle: OvmsVehicle,
  metric: string,
  payload: string,
  at: Date,
): OvmsVehicle {
  const next = { ...vehicle, updatedAt: at };
  switch (metric) {
    case 'v/b/soc':
      next.soc = parseNum(payload);
      break;
    case 'v/b/range/est':
      next.rangeEstKm = parseNum(payload);
      break;
    case 'v/p/odometer':
      next.odometerKm = parseNum(payload);
      break;
    case 'v/c/charging':
      next.charging = parseOvmsBool(payload);
      break;
    case 'v/b/power':
      // kW, negative while charging (battery's point of view); flipped and scaled to +W.
      {
        const kw = parseNum(payload);
        next.chargePowerW = kw === null ? null : Math.round(-kw * 1000);
      }
      break;
    case 'v/b/voltage':
      next.batteryVoltage = parseNum(payload);
      break;
    case 'v/b/current':
      next.batteryCurrent = parseNum(payload);
      break;
    default:
      return vehicle;
  }
  return next;
}

/** Subscribed paths — OVMS publishes hundreds of metrics. */
export const OVMS_METRICS = [
  'v/b/soc',
  'v/b/range/est',
  'v/p/odometer',
  'v/c/charging',
  'v/b/power',
  'v/b/voltage',
  'v/b/current',
] as const;
