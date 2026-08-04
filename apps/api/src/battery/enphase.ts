import * as https from 'node:https';
import { BatteryReading, BatterySource } from './types';

/**
 * Enphase IQ Battery / Encharge, via the Envoy's local `/production.json`.
 *
 * Local: the Envoy serves this on the LAN. From firmware D7 it requires a JWT, which
 * the owner obtains once from Enlighten and pastes in — Enphase gives no way to mint
 * one locally, so the token is the price of local access rather than a design choice
 * on our part. Older firmware answers without it.
 *
 * Like the Powerwall gateway, the Envoy presents a self-signed certificate for an IP
 * address, so verification is off for this host.
 */

const PRODUCTION_PATH = '/production.json';
const REQUEST_TIMEOUT_MS = 10_000;

export interface EnvoyStorage {
  type?: string;
  activeCount?: number;
  /** Instantaneous watts. */
  wNow?: number;
  /** Energy currently stored, Wh. */
  whNow?: number;
  /** "idle" | "charging" | "discharging" | "full". */
  state?: string;
  percentFull?: number;
}

export interface EnvoyProduction {
  production?: Array<{ type?: string; wNow?: number }>;
  storage?: EnvoyStorage[];
}

/**
 * Fold the Envoy's storage array into one reading.
 *
 * `storage` is an array because an Envoy can report several battery groups, and a
 * system with none still returns the key — as a single entry with `activeCount: 0`.
 * Treating "the key exists" as "there is a battery" would report a confident 0% for
 * every solar-only Envoy in existence.
 *
 * `percentFull` is averaged rather than summed, weighted by nothing: Enphase reports
 * per-group percentages and there is no per-group capacity in this payload to weight
 * by. With one group — the overwhelmingly common case — that is exact.
 */
export function parseEnvoyStorage(payload: EnvoyProduction): BatteryReading | null {
  const groups = (payload?.storage ?? []).filter(
    (group) => (group.activeCount ?? 0) > 0 && typeof group.percentFull === 'number',
  );
  if (groups.length === 0) return null;

  const soc =
    groups.reduce((sum, group) => sum + (group.percentFull ?? 0), 0) / groups.length;
  const watts = groups.reduce((sum, group) => sum + (group.wNow ?? 0), 0);
  const storedWh = groups.reduce((sum, group) => sum + (group.whNow ?? 0), 0);

  /*
    Enphase reports wNow positive when DISCHARGING, matching its "energy leaving the
    battery" framing. This app treats positive as charging, so the sign flips — the
    same trap as the Powerwall, and just as invisible on a chart if missed.
  */
  return {
    soc: Math.max(0, Math.min(100, soc)),
    powerW: -watts,
    /*
      Derived, not reported: whNow is what is currently stored, and percentFull says
      what fraction that is. Below a few percent the division amplifies rounding into
      nonsense, so it is left unknown rather than guessed.
    */
    capacityKwh: soc > 5 && storedWh > 0 ? Number((storedWh / (soc / 100) / 1000).toFixed(1)) : null,
    reservePct: null,
    cycles: null,
    name: 'IQ Battery',
    model: groups[0].type ? `Enphase ${groups[0].type}` : 'Enphase IQ Battery',
  };
}

function getJson(host: string, path: string, token: string | null): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(
              new Error(
                'The Envoy refused the request — firmware D7 and later needs an Enlighten token.',
              ),
            );
            return;
          }
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`${path} → HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error(`${path} returned non-JSON — is ${host} an Enphase Envoy?`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${host} did not answer within ${REQUEST_TIMEOUT_MS} ms`));
    });
    req.end();
  });
}

export class EnphaseClient implements BatterySource {
  constructor(
    private readonly host: string,
    private readonly token: string | null,
  ) {}

  async read(): Promise<BatteryReading> {
    const payload = (await getJson(this.host, PRODUCTION_PATH, this.token)) as EnvoyProduction;
    const reading = parseEnvoyStorage(payload);
    if (!reading) {
      throw new Error(
        `${this.host} is an Envoy but reports no active battery — a solar-only system has none`,
      );
    }
    return reading;
  }
}
