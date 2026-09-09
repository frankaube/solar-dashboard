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
 * EcoFlow developer cloud API (developer.ecoflow.com). No local API exists: owner-generated
 * accessKey/secretKey, HMAC-SHA256 signed. Quota keys differ per device.
 */
export class EcoFlowClient {
  constructor(
    private readonly accessKey: string,
    private readonly secretKey: string,
  ) {}

  /** Sign a request. `nonce` is documented as a 6-digit integer. Algorithm in ecoflow-sign.ts. */
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
 * Map a `quota/all` response onto the shared battery model. Quota keys differ per product
 * line, so each field tries a list of candidates; no match yields null, never zero.
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

  // No recognisable key is a parse miss, not a flat battery.
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
