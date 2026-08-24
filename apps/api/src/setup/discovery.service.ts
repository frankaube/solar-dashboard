import { Injectable, Logger } from '@nestjs/common';
import * as net from 'node:net';
import { HoymilesDtuClient } from '../hoymiles/dtu-client';
import { DTU_PORT } from '../hoymiles/protocol';
import { FroniusClient, isFronius } from '../datasource/fronius.client';
import { OpenDtuClient, isOpenDtu } from '../datasource/opendtu.client';

// Embedded HTTP servers (Tesla Wall Connector especially) wedge under connection
// bursts — observed live: a concurrent port-80 sweep locked one up for many
// minutes. Bulk probing therefore touches ONLY the DTU port; HTTP fingerprinting
// runs sequentially, paced, against hosts already known to be alive.
const CONNECT_TIMEOUT_MS = 1_500;
const HTTP_TIMEOUT_MS = 3_000;
const HTTP_PACING_MS = 400;
const SCAN_CONCURRENCY = 32;
const HTTP_SWEEP_CONCURRENCY = 8;
const HTTP_PORT = 80;
const SUBNET_HOST_MIN = 1;
const SUBNET_HOST_MAX = 254;

type ProbeOutcome = 'open' | 'refused' | 'silent';

export interface DiscoveredDtu {
  host: string;
  vendor: 'hoymiles' | 'fronius' | 'opendtu';
  serialNumber: string;
  inverterCount: number;
  pvCount: number;
}

export interface DiscoveredCharger {
  host: string;
  vendor: 'tesla-wall-connector';
  gridVoltage: number;
}

export interface ScanResult {
  subnet: string;
  dtus: DiscoveredDtu[];
  chargers: DiscoveredCharger[];
  scannedHosts: number;
}

/** A refused connection still proves a live host — the TCP stack answered. */
function probePort(host: string, port: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (outcome: ProbeOutcome): void => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done('silent'));
    socket.on('connect', () => done('open'));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      done(error.code === 'ECONNREFUSED' ? 'refused' : 'silent'),
    );
  });
}

/**
 * Probe a /24 for supported energy gear. Each device type has a cheap fingerprint:
 * Hoymiles DTUs answer protobuf on TCP 10081, Tesla Wall Connectors serve
 * /api/1/vitals on TCP 80. New vendors add a probe here and an adapter in
 * src/datasource (see docs/vendors.md).
 */
@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  async scan(subnetPrefix: string): Promise<ScanResult> {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnetPrefix)) {
      throw new Error('subnet must look like "192.168.1"');
    }
    this.logger.log(`Scanning ${subnetPrefix}.0/24 for solar and EV gear…`);
    const hosts: string[] = [];
    for (let n = SUBNET_HOST_MIN; n <= SUBNET_HOST_MAX; n++) {
      hosts.push(`${subnetPrefix}.${n}`);
    }

    // Phase 1: sweep the DTU port. This also warms the ARP cache for phase 2.
    // (RST-based alive-detection is NOT sufficient here: fragile embedded stacks
    // — the Tesla Wall Connector among them — silently drop SYNs to closed ports.)
    const dtuCandidates: string[] = [];
    for (let i = 0; i < hosts.length; i += SCAN_CONCURRENCY) {
      const batch = hosts.slice(i, i + SCAN_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (host) => ({ host, dtu: await probePort(host, DTU_PORT) })),
      );
      for (const result of results) {
        if (result.dtu === 'open') dtuCandidates.push(result.host);
      }
    }

    // Phase 1.5: find HTTP listeners with a deliberately tame sweep — low
    // concurrency, exactly one SYN per host, ARP already warm from phase 1.
    const httpHosts: string[] = [];
    for (let i = 0; i < hosts.length; i += HTTP_SWEEP_CONCURRENCY) {
      const batch = hosts.slice(i, i + HTTP_SWEEP_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (host) => ({ host, http: await probePort(host, HTTP_PORT) })),
      );
      for (const result of results) {
        if (result.http === 'open') httpHosts.push(result.host);
      }
    }

    const dtus: DiscoveredDtu[] = [];
    for (const host of dtuCandidates) {
      try {
        const info = await new HoymilesDtuClient(host).fetchInfo();
        dtus.push({
          host,
          vendor: 'hoymiles',
          serialNumber: info.serialNumber,
          inverterCount: info.inverterCount,
          pvCount: info.pvCount,
        });
      } catch {
        // Port open but not a (responsive) Hoymiles DTU.
      }
    }

    // Phase 2: sequential, paced HTTP fingerprinting — one host at a time, one
    // request each, Connection: close. Fragile embedded servers stay standing.
    const chargers: DiscoveredCharger[] = [];
    for (const host of httpHosts) {
      try {
        const response = await fetch(`http://${host}/api/1/vitals`, {
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          headers: { connection: 'close' },
        });
        if (response.ok) {
          const body = (await response.json()) as { contactor_closed?: unknown; grid_v?: number };
          if (body.contactor_closed !== undefined) {
            chargers.push({
              host,
              vendor: 'tesla-wall-connector',
              gridVoltage: Number(body.grid_v ?? 0),
            });
          }
        }
      } catch {
        // Not a Wall Connector (or not an HTTP server at all).
      }

      // Same gentle pass also fingerprints HTTP-based solar gateways.
      try {
        if (await isFronius(host)) {
          const info = await new FroniusClient(host).fetchInfo();
          dtus.push({ host, vendor: 'fronius', serialNumber: info.serialNumber, inverterCount: info.inverterCount, pvCount: info.pvCount });
        } else if (await isOpenDtu(host)) {
          const info = await new OpenDtuClient(host).fetchInfo();
          dtus.push({ host, vendor: 'opendtu', serialNumber: info.serialNumber, inverterCount: info.inverterCount, pvCount: info.pvCount });
        }
      } catch {
        // Not a recognized solar gateway.
      }
      await new Promise((resolve) => setTimeout(resolve, HTTP_PACING_MS));
    }

    this.logger.log(
      `Scan of ${subnetPrefix}.0/24 done: ${dtus.length} solar gateway(s), ${chargers.length} charger(s)`,
    );
    return { subnet: subnetPrefix, dtus, chargers, scannedHosts: hosts.length };
  }
}
