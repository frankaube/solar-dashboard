/**
 * PVOutput's wire format, and the rules about when this app is allowed to use it.
 *
 * Everything else in the app reads. This is the one thing that WRITES — it sends this
 * house's production to a server on the internet, where it becomes a public page. That
 * makes the interesting logic here not "how do I format a date" but "under exactly what
 * conditions does anything leave this machine", and both live in pure functions so the
 * answer is testable rather than buried in a timer.
 *
 * Off unless switched on, and impossible to switch on without a key and a system id the
 * owner pasted in themselves. A default-on uploader in a local-first app would be a
 * betrayal of the phrase.
 *
 * Contract from PVOutput's published API specification: r2 endpoints, `X-Pvoutput-Apikey`
 * and `X-Pvoutput-SystemId` headers, 60 requests an hour on a free account.
 */

export const ADD_STATUS_URL = 'https://pvoutput.org/service/r2/addstatus.jsp';
export const ADD_OUTPUT_URL = 'https://pvoutput.org/service/r2/addoutput.jsp';

/**
 * Requests an hour on a free account. Donation accounts get 300, but budgeting for the
 * smaller number costs nothing and guessing wrong gets the account throttled.
 */
export const FREE_LIMIT_PER_HOUR = 60;
/**
 * How much of that budget this app will spend.
 *
 * A third, not all of it. The key belongs to a person, not to this app — they may be
 * running an inverter script, a phone widget, or another integration against the same
 * account, and an uploader that spends the whole allowance leaves those returning 403 with
 * nothing to say why. Being a good guest is cheaper than being debugged.
 */
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
      Ask for the rate-limit headers, which are opt-in.

      PVOutput returns X-Rate-Limit-Remaining and friends only when the request carries
      `X-Rate-Limit: 1`. Without it every response is silent about the quota,
      `readRateState` reads nulls, and `maySpend` — which returns true on null — never
      holds anything back. The budget below was written, tested and shipped without this,
      so it was inert: the throttle existed and could not engage.
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
 * One live status, as form-encoded parameters.
 *
 * Values are rounded, not truncated to a fixed precision: PVOutput rejects a request whose
 * numbers are out of range rather than clamping them, and a float with sixteen digits is a
 * claim to a precision a five-minute average does not have.
 *
 * Null and undefined are dropped rather than sent empty. An empty `v5` is not "no
 * temperature" to a form parser — it is a temperature of zero degrees, which on a January
 * afternoon is both plausible and wrong.
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

/**
 * Read the quota back off a response.
 *
 * The server is the authority on what is left — a local counter drifts the moment anything
 * else uses the same key, which is exactly the case this app cannot see.
 */
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

/**
 * Whether to spend a request now.
 *
 * Holds back once the remaining quota falls under the share this app allows itself, and
 * releases again when the server says the window has rolled over. Refusing to send is
 * always safe here: the next tick carries the same figure a few minutes later, and a
 * status nobody uploaded costs a gap in a graph, where a throttled key costs the owner
 * every integration they have.
 */
export function maySpend(state: RateState, now: number): boolean {
  if (state.remaining === null) return true;
  if (state.resetAt !== null && now >= state.resetAt) return true;
  return state.remaining > FREE_LIMIT_PER_HOUR * (1 - BUDGET_SHARE);
}

export type UploadOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string };

/**
 * What a response means, in the only two terms the caller acts on.
 *
 * The distinction that matters is retryable versus not. A 401 is a wrong key and will be
 * wrong again in five minutes — retrying it forever turns one typo into a permanent stream
 * of failed requests against someone's account. A 500 is the far end having a bad moment.
 */
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
