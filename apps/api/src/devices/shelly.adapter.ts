import { Device } from '@prisma/client';
import {
  pickShellyComponents,
  shellyChannels,
  shellyTotalEnergyWh,
  shellyTotalPowerW,
  shellyTotalReturnedWh,
  wattMinutesToWh,
} from './metering';
import { DeviceAdapter, DeviceState } from './types';

const TIMEOUT_MS = 3_000;

/** Shelly /shelly identity (Gen2+ has `gen`, Gen1 does not). */
export interface ShellyInfo {
  id?: string;
  name?: string | null;
  model?: string;
  gen?: number;
  mac?: string;
  app?: string;
}

async function get(host: string, path: string): Promise<unknown> {
  const response = await fetch(`http://${host}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { connection: 'close' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function shellyInfo(host: string): Promise<ShellyInfo> {
  return (await get(host, '/shelly')) as ShellyInfo;
}

interface Gen2Status {
  [key: string]: unknown;
  wifi?: { rssi?: number };
}

interface Gen1Status {
  relays?: Array<{ ison?: boolean }>;
  /** Plugs/relays: `total` is watt-MINUTES. */
  meters?: Array<{ power?: number; total?: number }>;
  /** EM/3EM: `total` here really is watt-hours — different field, different unit. */
  emeters?: Array<{ power?: number; total?: number }>;
  wifi_sta?: { rssi?: number };
}

/**
 * Shelly plugs/relays over their local HTTP API. Supports Gen2+ (RPC, the
 * common metered plugs — Plus Plug, Plus 1PM, Pro) and legacy Gen1. Implemented
 * from Shelly's documented API; adopt one via the scan to exercise on hardware.
 */
export class ShellyAdapter implements DeviceAdapter {
  vendor = 'shelly';

  private gen(device: Device): number {
    try {
      return device.config ? (JSON.parse(device.config).gen ?? 2) : 2;
    } catch {
      return 2;
    }
  }

  async poll(device: Device): Promise<DeviceState> {
    try {
      if (this.gen(device) >= 2) {
        const status = (await get(device.host, '/rpc/Shelly.GetStatus')) as Gen2Status;
        // Walk every metered component rather than just switch:0/pm1:0 — a whole-home
        // EM reports on em1:0..2, a metered dimmer on light:0, and reading only the
        // first two keys meant those devices reported no power at all.
        const components = pickShellyComponents(status as Record<string, unknown>);
        const first = components[0];
        const channels = shellyChannels(components);
        return {
          reachable: true,
          on: first?.output,
          powerW: shellyTotalPowerW(components),
          energyWh: shellyTotalEnergyWh(components),
          energyReturnedWh: shellyTotalReturnedWh(components),
          temperatureC: first?.temperature?.tC ?? null,
          rssi: status.wifi?.rssi ?? null,
          // A Pro 3EM / EM Gen3 records each leg as well as the total; a single-channel
          // plug returns none, so nothing redundant is written.
          ...(channels.length ? { channels } : {}),
        };
      }
      const status = (await get(device.host, '/status')) as Gen1Status;
      // Gen1 splits these across two fields with DIFFERENT units: `emeters[].total`
      // (EM/3EM) is watt-hours, while `meters[].total` (plugs/relays) is
      // watt-minutes. The latter was previously returned raw — a 60x overstatement.
      const em = status.emeters?.[0];
      const meter = status.meters?.[0];
      const energyWh =
        em?.total !== undefined
          ? em.total
          : meter?.total !== undefined
            ? wattMinutesToWh(meter.total)
            : null;
      return {
        reachable: true,
        on: status.relays?.[0]?.ison,
        powerW: em?.power ?? meter?.power ?? null,
        energyWh,
        rssi: status.wifi_sta?.rssi ?? null,
      };
    } catch {
      return { reachable: false };
    }
  }

  async setOn(device: Device, on: boolean): Promise<void> {
    if (this.gen(device) >= 2) {
      await get(device.host, `/rpc/Switch.Set?id=0&on=${on}`);
    } else {
      await get(device.host, `/relay/0?turn=${on ? 'on' : 'off'}`);
    }
  }
}
