import { Device } from '@prisma/client';
import { DeviceAdapter, DeviceState } from './types';

const TIMEOUT_MS = 3_000;
/**
 * The HLW8032/CSE7766 metering ICs these plugs use report noise below roughly this
 * load, and Athom documents it explicitly ("occasionally report invalid power
 * measurements for load values below 5 W"). Clamp rather than record phantom draw.
 */
const MIN_CREDIBLE_W = 0.5;
const WH_PER_KWH = 1000;

async function cmnd(host: string, command: string): Promise<unknown> {
  const response = await fetch(`http://${host}/cm?cmnd=${encodeURIComponent(command)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { connection: 'close' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

interface TasmotaStatus0 {
  Status?: { DeviceName?: string; FriendlyName?: string[]; Module?: number };
  StatusFWR?: { Version?: string; Hardware?: string };
  StatusNET?: { Mac?: string; Hostname?: string };
  StatusSTS?: {
    POWER?: string;
    POWER1?: string;
    Wifi?: { RSSI?: number; Signal?: number };
  };
  StatusSNS?: {
    ENERGY?: {
      Power?: number;
      Total?: number;
      Today?: number;
      Voltage?: number;
      Current?: number;
      Factor?: number;
    };
    /** Some builds expose a temperature probe alongside the energy monitor. */
    [key: string]: unknown;
  };
}

export interface TasmotaInfo {
  name?: string;
  version?: string;
  mac?: string;
  hardware?: string;
  metered: boolean;
}

/** Identity probe, also used as the LAN discovery fingerprint. */
export async function tasmotaInfo(host: string): Promise<TasmotaInfo> {
  const status = (await cmnd(host, 'Status 0')) as TasmotaStatus0;
  if (!status.Status && !status.StatusFWR) throw new Error('not Tasmota');
  return {
    name: status.Status?.DeviceName ?? status.Status?.FriendlyName?.[0],
    version: status.StatusFWR?.Version,
    mac: status.StatusNET?.Mac,
    hardware: status.StatusFWR?.Hardware,
    metered: status.StatusSNS?.ENERGY !== undefined,
  };
}

/**
 * Tasmota-flashed plugs and relays over their local HTTP command API. One adapter
 * covers every device running Tasmota — Athom, NOUS, Refoss, CloudFree, and any
 * self-flashed Sonoff/Shelly — which is the cheapest breadth available: the API is
 * plain HTTP, unauthenticated by default, identical across vendors, and the metered
 * models report real W / kWh / V / A rather than an estimate.
 *
 * `Status 0` returns identity, relay state, Wi-Fi and the energy monitor in a single
 * round trip, so a poll is one request.
 */
export class TasmotaAdapter implements DeviceAdapter {
  vendor = 'tasmota';

  async poll(device: Device): Promise<DeviceState> {
    try {
      const status = (await cmnd(device.host, 'Status 0')) as TasmotaStatus0;
      const sts = status.StatusSTS;
      const energy = status.StatusSNS?.ENERGY;
      const relay = sts?.POWER ?? sts?.POWER1;
      const watts = energy?.Power;
      return {
        reachable: true,
        on: relay === undefined ? undefined : relay === 'ON',
        // Tasmota reports Total in kWh; the shared model is Wh.
        powerW: watts === undefined ? null : watts < MIN_CREDIBLE_W ? 0 : watts,
        energyWh: energy?.Total === undefined ? null : energy.Total * WH_PER_KWH,
        // `RSSI` is a 0-100 quality percentage; `Signal` is the actual dBm, which is
        // what every other adapter here reports.
        rssi: sts?.Wifi?.Signal ?? null,
      };
    } catch {
      return { reachable: false };
    }
  }

  async setOn(device: Device, on: boolean): Promise<void> {
    await cmnd(device.host, `Power ${on ? 'ON' : 'OFF'}`);
  }
}
