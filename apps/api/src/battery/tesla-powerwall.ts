import * as https from 'node:https';
import { BatteryReading, BatterySource } from './types';

/**
 * Tesla Powerwall, via the Gateway's own local API.
 *
 * Entirely on the LAN — the gateway serves this itself, so nothing goes to Tesla. It
 * presents a self-signed certificate for an IP address, which no certificate authority
 * can vouch for, so verification is disabled for this host only. That is the gateway's
 * design, not a shortcut: there is no hostname to issue a certificate against.
 *
 * Since firmware 20.49 the endpoints need a bearer token, obtained by logging in with
 * the customer email and the gateway password (by default the last five characters of
 * its serial). Older firmware answers unauthenticated, so a missing token is not
 * treated as fatal until a request actually fails.
 */

const LOGIN_PATH = '/api/login/Basic';
const SOE_PATH = '/api/system_status/soe';
const AGGREGATES_PATH = '/api/meters/aggregates';
const STATUS_PATH = '/api/system_status';
const REQUEST_TIMEOUT_MS = 10_000;

export interface PowerwallSoe {
  percentage?: number;
}

export interface PowerwallMeter {
  /** Newer firmware. */
  instant_power?: number;
  /** Older firmware calls the same field this. */
  real_power_w?: number;
}

export interface PowerwallAggregates {
  battery?: PowerwallMeter;
  solar?: PowerwallMeter;
  site?: PowerwallMeter;
  load?: PowerwallMeter;
}

export interface PowerwallStatus {
  nominal_full_pack_energy?: number;
  nominal_energy_remaining?: number;
}

/**
 * Read a meter's watts across firmware revisions.
 *
 * The field was renamed between releases and both spellings are in the wild. Picking
 * one and ignoring the other yields a confident 0 W rather than an error, which is the
 * failure mode this codebase keeps finding.
 */
export function meterWatts(meter: PowerwallMeter | undefined): number | null {
  if (!meter) return null;
  const value = meter.instant_power ?? meter.real_power_w;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Turn the gateway's three responses into a reading.
 *
 * THE SIGN IS INVERTED HERE, deliberately. Tesla reports battery power as positive
 * when DISCHARGING; every other source in this app, and the whole savings model,
 * treats positive as charging. Passing Tesla's number through unchanged would show a
 * battery filling up all evening and draining all day — plausible on a chart, exactly
 * backwards, and invisible without knowing the convention.
 */
export function parsePowerwall(
  soe: PowerwallSoe,
  aggregates: PowerwallAggregates,
  status?: PowerwallStatus,
): BatteryReading | null {
  const percentage = soe?.percentage;
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return null;

  const teslaWatts = meterWatts(aggregates?.battery);
  const fullPackWh = status?.nominal_full_pack_energy;

  return {
    soc: Math.max(0, Math.min(100, percentage)),
    powerW: teslaWatts === null ? 0 : -teslaWatts,
    capacityKwh:
      typeof fullPackWh === 'number' && fullPackWh > 0 ? fullPackWh / 1000 : null,
    reservePct: null,
    cycles: null,
    name: 'Powerwall',
    model: 'Tesla Powerwall',
  };
}

function request(
  host: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        host,
        path,
        method: payload ? 'POST' : 'GET',
        // The gateway's certificate is self-signed for an IP; nothing can verify it.
        rejectUnauthorized: false,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`${path} → HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`${path} returned non-JSON — is ${host} a Powerwall gateway?`));
          }
        });
      },
    );
    req.on('error', (error) => reject(error));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${host} did not answer within ${REQUEST_TIMEOUT_MS} ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export class PowerwallClient implements BatterySource {
  private token: string | null = null;

  constructor(
    private readonly host: string,
    private readonly email: string,
    private readonly password: string,
  ) {}

  private async login(): Promise<void> {
    const result = (await request(this.host, LOGIN_PATH, null, {
      username: 'customer',
      email: this.email,
      password: this.password,
      force_sm_off: false,
    })) as { token?: string };
    if (!result?.token) throw new Error('Powerwall login returned no token');
    this.token = result.token;
  }

  async read(): Promise<BatteryReading> {
    /*
      Try with whatever token we hold, and log in once on failure rather than logging
      in on every poll. Tokens outlive a single request, and re-authenticating each
      minute is both wasteful and a good way to get rate limited.
    */
    for (const attempt of [0, 1]) {
      if (attempt === 1 || (this.token === null && this.password)) {
        await this.login();
      }
      try {
        const [soe, aggregates, status] = await Promise.all([
          request(this.host, SOE_PATH, this.token) as Promise<PowerwallSoe>,
          request(this.host, AGGREGATES_PATH, this.token) as Promise<PowerwallAggregates>,
          // Optional: older firmware may not serve it, and capacity is a nicety.
          (request(this.host, STATUS_PATH, this.token) as Promise<PowerwallStatus>).catch(
            () => undefined,
          ),
        ]);
        const reading = parsePowerwall(soe, aggregates, status);
        if (!reading) throw new Error(`${this.host} answered but reported no state of charge`);
        return reading;
      } catch (error) {
        // Only a first-attempt failure is worth re-authenticating for.
        if (attempt === 1) throw error;
        this.token = null;
      }
    }
    throw new Error(`Could not read the Powerwall at ${this.host}`);
  }
}
