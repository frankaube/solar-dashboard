import { randomInt } from 'node:crypto';
import { ecoflowSign } from './ecoflow-sign';

const BASE_URL = 'https://api.ecoflow.com';
const TIMEOUT_MS = 8_000;

export interface EcoFlowDevice {
  sn: string;
  deviceName?: string;
  online?: number;
  productName?: string;
}

export interface BatterySourceState {
  present: true;
  name: string;
  model: string;
  soc: number;
  powerW: number; // + charging, − discharging
  capacityKwh: number | null;
  reservePct: number | null;
  cycles: number | null;
}

/**
 * EcoFlow via the official developer cloud API (developer.ecoflow.com). Not a
 * local API — it needs an accessKey/secretKey the owner generates, and requests
 * are HMAC-SHA256 signed. Quota keys differ per device, so the mapping below
 * tries the common names across Delta / River / PowerStream and degrades
 * gracefully. Implemented from EcoFlow's published API; keys are the user's.
 */
export class EcoFlowClient {
  constructor(
    private readonly accessKey: string,
    private readonly secretKey: string,
  ) {}

  /**
   * Sign a request. The algorithm lives in ecoflow-sign.ts so it can be checked
   * against EcoFlow's published test vector — see ecoflow-sign.spec.ts. `nonce` is
   * documented as a 6-digit integer.
   */
  private sign(params: unknown): { headers: Record<string, string> } {
    const nonce = String(randomInt(100000, 1000000));
    const timestamp = String(Date.now());
    const sign = ecoflowSign(params, {
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      nonce,
      timestamp,
    });
    return {
      headers: { accessKey: this.accessKey, nonce, timestamp, sign, 'Content-Type': 'application/json' },
    };
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const url = `${BASE_URL}${path}${query ? `?${query}` : ''}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: this.sign(params).headers,
    });
    if (!response.ok) throw new Error(`EcoFlow HTTP ${response.status}`);
    const body = (await response.json()) as { code?: string; message?: string; data?: T };
    if (body.code && body.code !== '0') throw new Error(`EcoFlow: ${body.message ?? body.code}`);
    return body.data as T;
  }

  async listDevices(): Promise<EcoFlowDevice[]> {
    return (await this.get<EcoFlowDevice[]>('/iot-open/sign/device/list')) ?? [];
  }

  async fetchState(sn: string): Promise<BatterySourceState | null> {
    const quota = await this.get<Record<string, number>>('/iot-open/sign/device/quota/all', { sn });
    return quota ? parseEcoFlowQuota(quota) : null;
  }
}

/**
 * Map a `quota/all` response onto the shared battery model.
 *
 * Split out from the HTTP call so it can be exercised against recorded payloads with
 * no credentials and no hardware — which is the only testing available here, and is
 * how the demo fixtures double as regression tests for this mapping.
 *
 * Quota keys differ per product line, so each field tries a list of candidates. That
 * is a guess by construction: EcoFlow documents the keys per device and we support
 * more devices than we own. Where nothing matches, the field is null rather than a
 * fabricated zero — an unknown state of charge must not render as an empty battery.
 */
export function parseEcoFlowQuota(quota: Record<string, number>): BatterySourceState | null {
  const pick = (...keys: string[]): number | null => {
    for (const k of keys) if (typeof quota[k] === 'number' && Number.isFinite(quota[k])) return quota[k];
    return null;
  };

  const soc = pick(
    'bms_bmsStatus.soc',
    'pd.soc',
    'bms_emsStatus.lcdShowSoc',
    'bmsMaster.soc',
    // Smart Home Panel 2 reports a combined pack figure under its own tree.
    'backupIncreInfo.backupBatPer',
  );
  const inW = pick('pd.wattsInSum', 'inv.inputWatts', 'pd.wattsIn');
  const outW = pick('pd.wattsOutSum', 'inv.outputWatts', 'pd.wattsOut');
  // SHP2 exposes signed per-battery channel power instead of separate in/out totals.
  const shpChannels = ['wattInfo.chWatt[0]', 'wattInfo.chWatt[1]', 'wattInfo.chWatt[2]']
    .map((k) => quota[k])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  // Nothing recognisable at all is a parse miss, not a flat battery. Report it as
  // absent so the UI can say "connected, not understood" rather than inventing 0%.
  if (soc === null && inW === null && outW === null && shpChannels.length === 0) return null;

  const powerW = shpChannels.length
    ? shpChannels.reduce((a, b) => a + b, 0)
    : (inW ?? 0) - (outW ?? 0);
  const designWh = pick('bms_bmsStatus.designCap', 'bmsMaster.designCap'); // mAh on some models

  return {
    present: true,
    name: 'EcoFlow',
    model: 'EcoFlow',
    soc: soc ?? 0,
    powerW,
    // designCap is often mAh at pack voltage; leave capacity null unless it looks like Wh.
    capacityKwh: designWh && designWh > 100 && designWh < 100000 ? designWh / 1000 : null,
    reservePct: pick('bms_emsStatus.minDsgSoc', 'pd.bppowerSoc', 'backupIncreInfo.backupReserveSoc'),
    cycles: pick('bms_bmsStatus.cycles', 'bmsMaster.cycles'),
  };
}
