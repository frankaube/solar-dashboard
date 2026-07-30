import { DiscoveredDevice } from '../types';
import {
  DiscoveryContext,
  DiscoveryProbe,
  ListenProbe,
  PortProbe,
  ScanResult,
  isPortProbe,
} from './types';

/** How many hosts to probe at once. Deliberately modest — see the pacing note below. */
const SWEEP_CONCURRENCY = 8;
/**
 * Gap between batches. Embedded HTTP stacks wedge under bursts — learned the hard way
 * from the Tesla Wall Connector — so the sweep stays deliberately unhurried.
 */
const PACING_MS = 120;

export type TcpProbeFn = (host: string, port: number) => Promise<boolean>;

/**
 * Runs registered probes against a subnet.
 *
 * The engine owns all the network planning; probes own only their vendor's
 * handshake. Two consequences worth stating, because they are the point:
 *
 *  - ONE sweep per distinct port, not per probe. Three probes want port 80, so port
 *    80 is swept once and each open host is offered to all three in priority order.
 *  - Listeners start first and are awaited last, so their windows overlap the sweeps
 *    rather than extending the scan.
 */
export class NetworkScanner {
  private readonly portProbes: PortProbe[];
  private readonly listenProbes: ListenProbe[];

  private readonly pacingMs: number;
  private readonly concurrency: number;

  constructor(
    probes: DiscoveryProbe[],
    private readonly tcpProbe: TcpProbeFn,
    // Injectable so tests do not sit through the real pacing — a sweep of 254 hosts
    // at 120 ms a batch is thirty seconds of wall clock per test otherwise.
    options: { pacingMs?: number; concurrency?: number } = {},
  ) {
    this.pacingMs = options.pacingMs ?? PACING_MS;
    this.concurrency = options.concurrency ?? SWEEP_CONCURRENCY;
    this.portProbes = probes.filter(isPortProbe);
    this.listenProbes = probes.filter((p): p is ListenProbe => !isPortProbe(p));
  }

  /** Every label this scanner can recognise — the basis of an honest "not found". */
  lookedFor(): string[] {
    return [...new Set([...this.listenProbes, ...this.portProbes].map((p) => p.label))].sort();
  }

  async scan(subnetPrefix: string, ctx: DiscoveryContext): Promise<ScanResult> {
    const hosts: string[] = [];
    for (let n = 1; n <= 254; n++) hosts.push(`${subnetPrefix}.${n}`);

    // Start listeners now; await them at the end. A passive listener that only runs
    // after the sweeps would add its whole window to the scan for no reason.
    const listening = this.listenProbes.map((probe) =>
      probe.listen(subnetPrefix, ctx).catch(() => [] as DiscoveredDevice[]),
    );

    const byPort = new Map<number, PortProbe[]>();
    for (const probe of this.portProbes) {
      const list = byPort.get(probe.port) ?? [];
      list.push(probe);
      byPort.set(probe.port, list);
    }
    for (const list of byPort.values()) {
      list.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    }

    const found: DiscoveredDevice[] = [];
    for (const [port, probes] of byPort) {
      for (const host of await this.sweep(hosts, port)) {
        for (const probe of probes) {
          try {
            const device = await probe.identify(host, ctx);
            if (device) {
              found.push(device);
              break; // first probe to recognise it claims the host on this port
            }
          } catch {
            /* wrong vendor for this host, or it hung up — try the next probe */
          }
        }
      }
    }

    const announced = (await Promise.all(listening)).flat();
    return { devices: merge(announced, found), lookedFor: this.lookedFor() };
  }

  /** One paced pass over the subnet for a single port. */
  private async sweep(hosts: string[], port: number): Promise<string[]> {
    const open: string[] = [];
    for (let i = 0; i < hosts.length; i += this.concurrency) {
      const batch = hosts.slice(i, i + this.concurrency);
      const results = await Promise.all(batch.map((host) => this.tcpProbe(host, port)));
      batch.forEach((host, j) => results[j] && open.push(host));
      if (this.pacingMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pacingMs));
    }
    return open;
  }
}

/**
 * Combine listener and port results, preferring the listener's.
 *
 * A device can legitimately be found both ways — Tuya announces itself over UDP and
 * also accepts TCP on 6668. The announcement carries a device id and protocol
 * version; the port probe carries only an address. Same device, so it must appear
 * once, and the richer record is the one to keep.
 */
function merge(announced: DiscoveredDevice[], probed: DiscoveredDevice[]): DiscoveredDevice[] {
  const out = [...announced];
  const claimed = new Set(announced.map((d) => `${d.vendor}|${d.host}`));
  for (const device of probed) {
    if (claimed.has(`${device.vendor}|${device.host}`)) continue;
    claimed.add(`${device.vendor}|${device.host}`);
    out.push(device);
  }
  return out;
}
