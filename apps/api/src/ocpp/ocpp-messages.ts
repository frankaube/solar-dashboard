/**
 * OCPP 1.6J framing and the bits of it worth reading.
 *
 * OCPP is why this is the best charger option available, and the reason is not its
 * device count. It INVERTS THE CONNECTION: the charge point is a WebSocket client that
 * dials out to a URL you configure on it, so there is no scan, no mDNS, no broadcast and
 * no subnet to guess. On this install that matters concretely — a bridged Docker
 * container cannot hear announcements, which is why a Tuya plug stayed invisible for
 * months. A charge point arrives on its own regardless.
 *
 * Only monitoring is implemented. Every message is answered so the charge point stays
 * happy, but nothing here commands it; `SetChargingProfile` and friends are a separate
 * decision with real safety implications and are deliberately absent.
 *
 * Framing is a JSON array with a leading type id:
 *   CALL        [2, uniqueId, action, payload]
 *   CALLRESULT  [3, uniqueId, payload]
 *   CALLERROR   [4, uniqueId, errorCode, errorDescription, errorDetails]
 */

export const OCPP_SUBPROTOCOL = 'ocpp1.6';

export enum MessageType {
  Call = 2,
  CallResult = 3,
  CallError = 4,
}

export interface OcppCall {
  type: MessageType.Call;
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

/** A reading pulled out of MeterValues, normalised to watts and watt-hours. */
export interface MeterReading {
  at: Date;
  powerW: number | null;
  /** Lifetime import register, in Wh. */
  energyWh: number | null;
  soc: number | null;
  currentA: number | null;
  voltageV: number | null;
}

export function parseCall(raw: string): OcppCall | null {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(frame) || frame.length < 3) return null;
  if (frame[0] !== MessageType.Call) return null;
  const [, id, action, payload] = frame as [number, unknown, unknown, unknown];
  if (typeof id !== 'string' || typeof action !== 'string') return null;
  return {
    type: MessageType.Call,
    id,
    action,
    payload: payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {},
  };
}

export function callResult(id: string, payload: Record<string, unknown>): string {
  return JSON.stringify([MessageType.CallResult, id, payload]);
}

export function callError(id: string, code: string, description: string): string {
  return JSON.stringify([MessageType.CallError, id, code, description, {}]);
}

/**
 * The reply a charge point needs for each message it sends.
 *
 * Everything is accepted. A central system that rejects an action it does not recognise
 * gets a charge point that retries forever or drops the connection, and this one is here
 * to watch rather than to police — so unknown actions get an empty result, which OCPP
 * permits, instead of a CALLERROR.
 */
export function replyFor(action: string, now: Date): Record<string, unknown> {
  switch (action) {
    case 'BootNotification':
      return { status: 'Accepted', currentTime: now.toISOString(), interval: 300 };
    case 'Heartbeat':
      return { currentTime: now.toISOString() };
    case 'Authorize':
    case 'StartTransaction':
      /*
        Always authorised. This is a home charge point on its owner's own network; an
        idTagInfo of Invalid would simply stop their car charging, which is a worse
        outcome than any access control it might buy.
      */
      return action === 'Authorize'
        ? { idTagInfo: { status: 'Accepted' } }
        : { transactionId: Math.floor(now.getTime() / 1000), idTagInfo: { status: 'Accepted' } };
    case 'StopTransaction':
      return { idTagInfo: { status: 'Accepted' } };
    case 'StatusNotification':
    case 'MeterValues':
    case 'DiagnosticsStatusNotification':
    case 'FirmwareStatusNotification':
      return {};
    default:
      return {};
  }
}

/** Scale a sampled value to a base unit, from whatever unit the charge point declared. */
function toBase(value: number, unit: string | null, kind: 'power' | 'energy'): number {
  const u = (unit ?? '').toLowerCase();
  if (kind === 'power') return u === 'kw' ? value * 1000 : value;
  return u === 'kwh' ? value * 1000 : value;
}

/**
 * Pull the useful numbers out of a MeterValues payload.
 *
 * Two things make this less trivial than it looks. Charge points declare their own units
 * and disagree — kW and W, kWh and Wh — so every value is scaled by its declared unit
 * rather than assumed. And a value with no `measurand` means `Energy.Active.Import.Register`
 * per the spec, which is easy to drop and shows up as a charger that reports power but
 * never accumulates energy.
 */
export function parseMeterValues(payload: Record<string, unknown>): MeterReading[] {
  const entries = Array.isArray(payload.meterValue) ? payload.meterValue : [];
  const out: MeterReading[] = [];
  for (const entry of entries) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const stamp = typeof e.timestamp === 'string' ? new Date(e.timestamp) : new Date();
    const samples = Array.isArray(e.sampledValue) ? e.sampledValue : [];
    const reading: MeterReading = {
      at: Number.isNaN(stamp.getTime()) ? new Date() : stamp,
      powerW: null,
      energyWh: null,
      soc: null,
      currentA: null,
      voltageV: null,
    };
    for (const sample of samples) {
      const s = (sample ?? {}) as Record<string, unknown>;
      const value = Number(s.value);
      if (!Number.isFinite(value)) continue;
      const unit = typeof s.unit === 'string' ? s.unit : null;
      // Absent measurand means the energy register, per the OCPP 1.6 spec.
      const measurand = typeof s.measurand === 'string' ? s.measurand : 'Energy.Active.Import.Register';
      const phase = typeof s.phase === 'string' ? s.phase : null;
      switch (measurand) {
        case 'Power.Active.Import':
          // Per-phase samples are summed; a total arrives with no phase and wins.
          reading.powerW =
            phase === null ? toBase(value, unit, 'power') : (reading.powerW ?? 0) + toBase(value, unit, 'power');
          break;
        case 'Energy.Active.Import.Register':
          reading.energyWh = toBase(value, unit, 'energy');
          break;
        case 'SoC':
          reading.soc = value;
          break;
        case 'Current.Import':
          reading.currentA = phase === null ? value : Math.max(reading.currentA ?? 0, value);
          break;
        case 'Voltage':
          reading.voltageV = phase === null ? value : Math.max(reading.voltageV ?? 0, value);
          break;
        default:
          break;
      }
    }
    out.push(reading);
  }
  return out;
}

/** OCPP status values that mean a vehicle is physically plugged in. */
const CONNECTED_STATUSES = new Set(['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing']);

export function statusMeansConnected(status: unknown): boolean {
  return typeof status === 'string' && CONNECTED_STATUSES.has(status);
}

/**
 * The charge point id from the WebSocket path.
 *
 * OCPP-J puts it in the URL — `ws://host:port/CP0001` — and it is the only identity a
 * charge point offers before BootNotification arrives.
 */
export function chargePointIdFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const last = path.split('?')[0].split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last) : null;
}
