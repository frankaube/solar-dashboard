/**
 * PVOutput's wire format: r2 endpoints, `X-Pvoutput-Apikey` and `X-Pvoutput-SystemId`
 * headers, 60 requests an hour on a free account. The only outbound writer in the app — off
 * unless switched on, and unswitchable without a key and system id the owner pasted in.
 */

export const ADD_STATUS_URL = 'https://pvoutput.org/service/r2/addstatus.jsp';
export const ADD_OUTPUT_URL = 'https://pvoutput.org/service/r2/addoutput.jsp';

/** Free accounts get 60 an hour, donation accounts 300; budget for the smaller. */
export const FREE_LIMIT_PER_HOUR = 60;
/** Share of the hourly quota this app may spend; the same key may serve other integrations. */
export const BUDGET_SHARE = 1 / 3;

export interface PvoutputConfig {
  enabled: boolean;
  apiKey: string | null;
  systemId: string | null;
}

/** Whether anything at all may be sent. Every send path goes through this. */
export function canUpload(config: PvoutputConfig): boolean {
  return Boolean(
    config.enabled && config.apiKey && config.apiKey.trim() && config.systemId && config.systemId.trim(),
  );
}

export function authHeaders(config: PvoutputConfig): Record<string, string> {
  return {
    'X-Pvoutput-Apikey': (config.apiKey ?? '').trim(),
    'X-Pvoutput-SystemId': (config.systemId ?? '').trim(),
    'Content-Type': 'application/x-www-form-urlencoded',
    /*
      Opt-in: PVOutput sends X-Rate-Limit-Remaining and friends only when the request carries
      `X-Rate-Limit: 1`. Without it every response is silent about the quota, `readRateState`
      reads nulls, and `maySpend` — true on null — never holds anything back.
    */
    'X-Rate-Limit': '1',
  };
}

/** `yyyymmdd` — PVOutput's date, taken from an already-local YYYY-MM-DD. */
export function wireDate(localDate: string): string {
  return localDate.replace(/-/g, '');
}

export interface StatusReading {
  /** Site-local date, YYYY-MM-DD. */
  date: string;
  /** Site-local time, HH:MM. */
  time: string;
  /** Energy so far today, Wh. */
  energyWh: number;
  /** Instantaneous output, W. */
  powerW: number;
  /** Panel or ambient temperature, °C. Omitted when nothing measured it. */
  temperatureC?: number | null;
  /** Grid voltage. Omitted when unknown. */
  voltage?: number | null;
}

/**
 * One live status, form-encoded. Rounded — PVOutput rejects out-of-range numbers rather than
 * clamping. Null dropped rather than sent empty: an empty `v5` is 0 °C, not "no temperature".
 */
export function statusParams(reading: StatusReading): URLSearchParams {
  const params = new URLSearchParams({
    d: wireDate(reading.date),
    t: reading.time,
    v1: String(Math.max(0, Math.round(reading.energyWh))),
    v2: String(Math.max(0, Math.round(reading.powerW))),
  });
  if (reading.temperatureC !== null && reading.temperatureC !== undefined) {
    params.set('v5', reading.temperatureC.toFixed(1));
  }
  if (reading.voltage !== null && reading.voltage !== undefined) {
    params.set('v6', reading.voltage.toFixed(1));
  }
  return params;
}

export interface OutputReading {
  date: string;
  generatedWh: number;
  /** Energy exported past the meter, Wh. Only where a meter actually measured it. */
  exportedWh?: number | null;
  peakPowerW?: number | null;
  /** Site-local HH:MM of the peak. */
  peakTime?: string | null;
}

/** One day's total, as form-encoded parameters. */
export function outputParams(reading: OutputReading): URLSearchParams {
  const params = new URLSearchParams({
    d: wireDate(reading.date),
    g: String(Math.max(0, Math.round(reading.generatedWh))),
  });
  if (reading.exportedWh !== null && reading.exportedWh !== undefined) {
    params.set('e', String(Math.max(0, Math.round(reading.exportedWh))));
  }
  if (reading.peakPowerW) params.set('pp', String(Math.round(reading.peakPowerW)));
  if (reading.peakTime) params.set('pt', reading.peakTime);
  return params;
}

export interface RateState {
  /** What the server said was left, from `X-Rate-Limit-Remaining`. Null before any call. */
  remaining: number | null;
  /** Epoch ms when the window resets, from `X-Rate-Limit-Reset` (seconds). */
  resetAt: number | null;
}

/** The server is the authority: a local counter drifts once anything else uses the same key. */
export function readRateState(headers: {
  get(name: string): string | null;
}): RateState {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const resetSeconds = num('X-Rate-Limit-Reset');
  return {
    remaining: num('X-Rate-Limit-Remaining'),
    resetAt: resetSeconds === null ? null : resetSeconds * 1000,
  };
}

/** Holds below this app's share of the quota, releasing when the server says the window rolled over. */
export function maySpend(state: RateState, now: number): boolean {
  if (state.remaining === null) return true;
  if (state.resetAt !== null && now >= state.resetAt) return true;
  return state.remaining > FREE_LIMIT_PER_HOUR * (1 - BUDGET_SHARE);
}

export type UploadOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string };

/** Retryable or not: a 401 is a wrong key and stays wrong; a 500 is a bad moment. */
export function interpret(status: number, body: string): UploadOutcome {
  if (status >= 200 && status < 300) return { ok: true };
  const reason = body.trim().slice(0, 200) || `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return {
      ok: false,
      retryable: false,
      reason:
        status === 401
          ? `PVOutput rejected the key or system id (${reason}).`
          : `PVOutput refused the request — a read-only key, a donation-only feature, or the hourly limit (${reason}).`,
    };
  }
  if (status === 400) {
    return { ok: false, retryable: false, reason: `PVOutput would not accept the data (${reason}).` };
  }
  return { ok: false, retryable: true, reason };
}
