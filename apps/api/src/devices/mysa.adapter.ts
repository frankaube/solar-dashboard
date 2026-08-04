import { Device } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { DeviceAdapter, DeviceState } from './types';

/* eslint-disable @typescript-eslint/no-var-requires */
// hap-controller has no bundled types; loaded lazily so the app runs without it.
const { HttpClient } = require('hap-controller');

// HomeKit characteristic UUIDs (Apple-defined).
const CURRENT_TEMPERATURE = '00000011-0000-1000-8000-0026BB765291';
const TARGET_TEMPERATURE = '00000035-0000-1000-8000-0026BB765291';
const CURRENT_HEATING_STATE = '0000000F-0000-1000-8000-0026BB765291';

interface HapConfig {
  hapId: string;
  port: number;
  pairingData: unknown;
}

export interface HapCharacteristic {
  aid: number;
  iid: number;
  type: string;
  value: unknown;
}

function parseConfig(device: Device): HapConfig | null {
  if (!device.config) return null;
  try {
    return JSON.parse(device.config) as HapConfig;
  } catch {
    return null;
  }
}

export async function withClient<T>(
  device: Device,
  fn: (client: InstanceType<typeof HttpClient>) => Promise<T>,
): Promise<T> {
  const config = parseConfig(device);
  if (!config?.pairingData) throw new Error('device is not paired');
  const client = new HttpClient(config.hapId, device.host, config.port, config.pairingData);
  try {
    return await fn(client);
  } finally {
    try {
      await client.close?.();
    } catch {
      /* best effort */
    }
  }
}

export async function listCharacteristics(
  client: InstanceType<typeof HttpClient>,
): Promise<HapCharacteristic[]> {
  const accessories = (await client.getAccessories()) as {
    accessories: Array<{ aid: number; services: Array<{ characteristics: Array<{ iid: number; type: string; value: unknown }> }> }>;
  };
  const flat: HapCharacteristic[] = [];
  for (const accessory of accessories.accessories) {
    for (const service of accessory.services) {
      for (const characteristic of service.characteristics) {
        flat.push({ aid: accessory.aid, ...characteristic });
      }
    }
  }
  return flat;
}

export const matches = (type: string, uuid: string): boolean =>
  type.toUpperCase() === uuid || uuid.endsWith(`000000${type.toUpperCase()}-`.slice(-9));

/**
 * Mysa thermostats via their (local) HomeKit interface. Pairing happens once
 * through pairMysa(); the pairing keys live in Device.config.
 */
export class MysaAdapter implements DeviceAdapter {
  vendor = 'mysa';
  private readonly logger = new Logger(MysaAdapter.name);

  async poll(device: Device): Promise<DeviceState> {
    try {
      return await withClient(device, async (client) => {
        const characteristics = await listCharacteristics(client);
        const byType = (uuid: string): HapCharacteristic | undefined =>
          characteristics.find((c) => matches(c.type, uuid));
        const current = byType(CURRENT_TEMPERATURE);
        const target = byType(TARGET_TEMPERATURE);
        const heating = byType(CURRENT_HEATING_STATE);
        return {
          reachable: true,
          temperatureC: current ? Number(current.value) : null,
          setpointC: target ? Number(target.value) : null,
          heating: heating ? Number(heating.value) === 1 : undefined,
        };
      });
    } catch (error) {
      this.logger.debug(`poll ${device.name}: ${(error as Error).message}`);
      return { reachable: false };
    }
  }

  async setTargetTemperature(device: Device, celsius: number): Promise<void> {
    await withClient(device, async (client) => {
      const characteristics = await listCharacteristics(client);
      const target = characteristics.find((c) => matches(c.type, TARGET_TEMPERATURE));
      if (!target) throw new Error('no target-temperature characteristic');
      await client.setCharacteristics({ [`${target.aid}.${target.iid}`]: celsius });
    });
  }
}

/** One-time HomeKit pairing; returns the config JSON to store on the device. */
export async function pairMysa(
  host: string,
  port: number,
  hapId: string,
  pin: string,
): Promise<string> {
  const client = new HttpClient(hapId, host, port);
  const data = await client.startPairing();
  await client.finishPairing(data, pin.trim());
  const pairingData = client.getLongTermData();
  try {
    await client.close?.();
  } catch {
    /* best effort */
  }
  return JSON.stringify({ hapId, port, pairingData } satisfies HapConfig);
}
