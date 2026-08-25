import { DiscoveredDevice } from '../types';

/**
 * Discovery, as a set of registered probes rather than one long method.
 *
 * Probes must not scan for themselves: eight vendors would mean eight sweeps of 254 hosts,
 * slow and unkind to embedded network stacks. So probes DECLARE what they need and the
 * engine PLANS the work — one sweep per distinct port, however many probes want it.
 */

export interface DiscoveryContext {
  /** True when this vendor + hardware id is already adopted. */
  isAdopted(vendor: string, hardwareId?: string): boolean;
}

/**
 * A probe that identifies a device by connecting to a known TCP port. `identify` is only
 * called for hosts where the port is already open, so it can go straight to the handshake.
 */
export interface PortProbe {
  /** Vendor tag used in results and adoption. */
  vendor: string;
  /** Human label for what this looks for; surfaced so "not found" is explainable. */
  label: string;
  port: number;
  /**
   * Lower runs first when several probes share a port, and the first to return a device
   * claims that host: Shelly, Tasmota and ESPHome all answer on 80.
   */
  priority?: number;
  identify(host: string, ctx: DiscoveryContext): Promise<DiscoveredDevice | null>;
}

/**
 * A probe that listens rather than connects — mDNS queries, UDP broadcasts. Started before
 * the port sweeps and awaited after, so its window overlaps them.
 */
export interface ListenProbe {
  vendor: string;
  label: string;
  listen(subnetPrefix: string, ctx: DiscoveryContext): Promise<DiscoveredDevice[]>;
}

export type DiscoveryProbe = PortProbe | ListenProbe;

export function isPortProbe(probe: DiscoveryProbe): probe is PortProbe {
  return 'port' in probe;
}

export interface ScanResult {
  devices: DiscoveredDevice[];
  /**
   * What was actually looked for. Without it, "no Tuya devices found" and "never checked
   * for Tuya" are indistinguishable to whoever reads the result.
   */
  lookedFor: string[];
  /** Which subnets were actually covered — the other half of an honest "not found". */
  scanned?: string[];
}
