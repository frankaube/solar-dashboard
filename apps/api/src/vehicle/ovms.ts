/**
 * OVMS — the only genuinely local vehicle telemetry there is.
 *
 * An open-hardware dongle in the car's OBD2 port reads its CAN bus and publishes each
 * metric to its own MQTT topic. Supported vehicles include the Nissan Leaf, BMW i3,
 * Hyundai Ioniq 5, Kia Soul EV, Chevrolet Bolt, Smart EQ and Tesla Model S.
 *
 * Worth being clear about why this is the only local option: every mainstream EV
 * otherwise requires a manufacturer cloud account and a per-brand integration. OVMS costs
 * hardware and a trip to the car, and in exchange the data never leaves the house and
 * there is no vendor to depend on. See docs/ev-support-deepdive.md.
 *
 * Topics look like:
 *   ovms/<username>/<vehicleid>/metric/v/b/soc          ->  "54.5"
 *   ovms/<username>/<vehicleid>/metric/v/b/range/est    ->  "310"
 *   ovms/<username>/<vehicleid>/metric/v/c/charging     ->  "yes"
 *
 * One value per topic, as plain text. No JSON anywhere.
 */

export const OVMS_DEFAULT_PREFIX = 'ovms';

export interface OvmsVehicle {
  /** The vehicle id from the topic — OVMS's own label for the car. */
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

/**
 * Split an OVMS metric topic into the vehicle it belongs to and the metric path.
 *
 * The username sits between the prefix and the vehicle id and is not something to match
 * on — it differs per install and is not ours to know — so the shape is matched
 * positionally instead.
 */
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

/**
 * OVMS booleans are words, not 0/1.
 *
 * `v/c/charging` carries "yes" or "no". Coercing that with Boolean() makes "no" true,
 * which would report every parked car as charging.
 */
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

/**
 * Fold one metric into a vehicle's state.
 *
 * Returns a new object rather than mutating, so a caller can keep the previous reading
 * if a payload turns out to be unparseable.
 */
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
      /*
        OVMS reports battery power in kW, and signed: negative while charging, because
        the metric is from the battery's point of view. Flipped and scaled here so a
        charging car reports positive watts, matching how this app treats charging
        everywhere else.
      */
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
      // Everything else is ignored rather than stored. OVMS publishes hundreds of
      // metrics and a dashboard needs seven of them.
      return vehicle;
  }
  return next;
}

/** The metric paths worth subscribing to, so the handler is not handed hundreds. */
export const OVMS_METRICS = [
  'v/b/soc',
  'v/b/range/est',
  'v/p/odometer',
  'v/c/charging',
  'v/b/power',
  'v/b/voltage',
  'v/b/current',
] as const;
