import * as https from 'node:https';
import { BatteryReading, BatterySource } from './types';

/**
 * Enphase IQ Battery / Encharge, via the Envoy's local `/production.json`. Firmware D7 and
 * later requires an Enlighten JWT — Enphase provides no way to mint one locally; older
 * firmware answers without it. Certificate is self-signed for an IP, so verification is off.
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
 * Fold the Envoy's storage array into one reading. A batteryless system still returns
 * `storage`, as one entry with `activeCount: 0`. `percentFull` is averaged unweighted —
 * the payload carries no per-group capacity to weight by.
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

  // Enphase reports wNow positive when DISCHARGING; this app treats positive as charging.
  return {
    soc: Math.max(0, Math.min(100, soc)),
    powerW: -watts,
    // Derived: whNow / percentFull. Below a few percent the division is noise.
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
