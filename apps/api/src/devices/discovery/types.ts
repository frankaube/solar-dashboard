import { DiscoveredDevice } from '../types';

/**
 * Discovery, as a set of registered probes rather than one long method.
 *
 * The scan had grown into a sequence of hardcoded sweeps — TCP 9999 for Kasa, mDNS
 * for HomeKit, TCP 80 chained through Shelly then Tasmota then ESPHome, then UDP and
 * TCP for Tuya. Every new vendor meant editing that method, and the vendors still
 * waiting (Gree, Midea, Broadlink, SunSpec) would each have added another branch.
 *
 * The trap in the obvious object-oriented fix is letting each probe scan for itself:
 * eight vendors would mean eight sweeps of 254 hosts, which is slow and unkind to
 * embedded network stacks. So probes DECLARE what they need and the engine PLANS the
 * network work — one sweep per distinct port, however many probes want that port.
 *
 * Adding a vendor is now: write a probe, add it to the registry. No engine changes.
 */

export interface DiscoveryContext {
  /** True when this vendor + hardware id is already adopted. */
  isAdopted(vendor: string, hardwareId?: string): boolean;
}

/**
 * A probe that identifies a device by connecting to a known TCP port.
 *
 * `identify` is only called for hosts where the port is already known open, so it can
 * go straight to the vendor's own handshake without a reachability check.
 */
export interface PortProbe {
  /** Vendor tag used in results and adoption. */
  vendor: string;
  /** Human label for what this looks for; surfaced so "not found" is explainable. */
  label: string;
  port: number;
  /**
   * Lower runs first when several probes share a port. The first to return a device
   * claims that host — Shelly, Tasmota and ESPHome all answer on 80, and only one of
   * them is right.
   */
  priority?: number;
  identify(host: string, ctx: DiscoveryContext): Promise<DiscoveredDevice | null>;
}

/**
 * A probe that listens rather than connects — mDNS queries, UDP broadcasts.
 *
 * Started before the port sweeps and awaited after, so its window overlaps them
 * instead of adding to the total scan time.
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
   * What was actually looked for.
   *
   * Without this, "we found no Tuya devices" and "we never checked for Tuya" are
   * indistinguishable to the person reading the result — and for months the second
   * was true while the UI implied the first. A scan that reports three devices
   * should be able to say what it would have recognised.
   */
  lookedFor: string[];
  /** Which subnets were actually covered — the other half of an honest "not found". */
  scanned?: string[];
}
