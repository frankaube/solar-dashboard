import * as net from 'node:net';
import { DTU_PORT } from './protocol';
import { HoymilesDtuClient } from './dtu-client';

const SUBNET_HOST_MIN = 1;
const SUBNET_HOST_MAX = 254;
const CONNECT_TIMEOUT_MS = 500;
const SCAN_CONCURRENCY = 64;

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

/**
 * Scan a /24 for hosts answering on the DTU port, then confirm identity by
 * querying each candidate's serial number. Lets the collector follow the DTU
 * across DHCP address changes.
 *
 * @param subnetPrefix e.g. "10.0.0"
 * @param expectedSerial DTU serial the candidate must report
 */
export async function discoverDtuHost(
  subnetPrefix: string,
  expectedSerial: string,
  port: number = DTU_PORT,
): Promise<string | null> {
  const hosts: string[] = [];
  for (let n = SUBNET_HOST_MIN; n <= SUBNET_HOST_MAX; n++) {
    hosts.push(`${subnetPrefix}.${n}`);
  }

  const candidates: string[] = [];
  for (let i = 0; i < hosts.length; i += SCAN_CONCURRENCY) {
    const batch = hosts.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map((host) => probePort(host, port)));
    batch.forEach((host, idx) => {
      if (results[idx]) candidates.push(host);
    });
  }

  for (const host of candidates) {
    try {
      const info = await new HoymilesDtuClient(host, port).fetchInfo();
      if (info.serialNumber === expectedSerial) {
        return host;
      }
    } catch {
      // Not a (reachable) DTU — keep scanning.
    }
  }
  return null;
}

export function subnetPrefixOf(host: string): string {
  return host.split('.').slice(0, 3).join('.');
}
