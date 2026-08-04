import * as net from 'node:net';
import { Device } from '@prisma/client';
import { KasaEmeter, kasaHasEmeter, normaliseKasaEmeter } from './metering';
import { DeviceAdapter, DeviceState } from './types';

export const KASA_PORT = 9999;
const TIMEOUT_MS = 3_000;
const XOR_SEED = 171;

/** TP-Link Kasa "autokey XOR" framing (length-prefixed). */
function encrypt(json: string): Buffer {
  const payload = Buffer.from(json);
  const out = Buffer.alloc(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  let key = XOR_SEED;
  for (let i = 0; i < payload.length; i++) {
    key = payload[i] ^ key;
    out[4 + i] = key;
  }
  return out;
}

function decrypt(buf: Buffer): string {
  let key = XOR_SEED;
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key;
    key = buf[i];
  }
  return out.toString();
}

export function kasaRequest(host: string, command: object): Promise<Record<string, never>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: KASA_PORT });
    let data = Buffer.alloc(0);
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(TIMEOUT_MS, () => fail(new Error('kasa timeout')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(encrypt(JSON.stringify(command))));
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 4 && data.length >= 4 + data.readUInt32BE(0)) {
        socket.destroy();
        try {
          resolve(JSON.parse(decrypt(data.subarray(4))));
        } catch (error) {
          reject(error as Error);
        }
      }
    });
  });
}

export interface KasaSysinfo {
  model?: string;
  alias?: string;
  mac?: string;
  relay_state?: number;
  rssi?: number;
  mic_type?: string;
  /** Colon-separated capability list; contains "ENE" on metering models. */
  feature?: string;
}

export async function kasaSysinfo(host: string): Promise<KasaSysinfo> {
  const response = await kasaRequest(host, { system: { get_sysinfo: {} } });
  return (response as { system?: { get_sysinfo?: KasaSysinfo } }).system?.get_sysinfo ?? {};
}

/**
 * Read the energy monitor. The module name differs by device class — plugs and
 * strips use `emeter`, bulbs use `smartlife.iot.common.emeter` — so try the plug
 * module first and fall back rather than probing the model list.
 */
async function kasaEmeter(host: string): Promise<KasaEmeter | undefined> {
  for (const module of ['emeter', 'smartlife.iot.common.emeter']) {
    try {
      const response = (await kasaRequest(host, { [module]: { get_realtime: {} } })) as Record<
        string,
        { get_realtime?: KasaEmeter & { err_code?: number } }
      >;
      const realtime = response[module]?.get_realtime;
      if (realtime && !realtime.err_code) return realtime;
    } catch {
      /* try the next module */
    }
  }
  return undefined;
}

export class KasaAdapter implements DeviceAdapter {
  vendor = 'kasa';

  async poll(device: Device): Promise<DeviceState> {
    try {
      const info = await kasaSysinfo(device.host);
      // HS110/KP115/KP125/HS300 are the highest-volume metering plugs in North
      // America and this adapter read none of it. The capability is advertised in
      // the sysinfo we already fetch, so the extra round trip only happens on
      // hardware that can answer it.
      const emeter = kasaHasEmeter(info.feature) ? await kasaEmeter(device.host) : undefined;
      const metered = normaliseKasaEmeter(emeter);
      return {
        reachable: true,
        on: info.relay_state === 1,
        powerW: metered.powerW,
        energyWh: metered.energyWh,
        rssi: info.rssi ?? null,
      };
    } catch {
      return { reachable: false };
    }
  }

  async setOn(device: Device, on: boolean): Promise<void> {
    await kasaRequest(device.host, { system: { set_relay_state: { state: on ? 1 : 0 } } });
  }
}
