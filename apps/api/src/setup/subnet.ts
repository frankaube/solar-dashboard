import { networkInterfaces } from 'node:os';

/** Docker bridge networks (container-internal, never the user's LAN). */
function isDockerBridge(ip: string): boolean {
  return /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** The /24 an address belongs to, or null if it is not one. */
export function subnetOf(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const match = ip.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  return match ? match[1] : null;
}

/**
 * Best guess at the LAN /24 from our own interfaces.
 *
 * Works in a native (Lite) build. Inside Docker the container sits on a bridge
 * network, so this returns the bridge address — useless for finding the user's gear,
 * which is why it is filtered out and ranked below evidence from real devices.
 */
export function detectLanSubnet(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !isDockerBridge(addr.address)) {
        return subnetOf(addr.address);
      }
    }
  }
  return null;
}

export const COMMON_SUBNETS = ['192.168.1', '192.168.0', '10.0.0'];

export type SubnetConfidence =
  /** Something we actually talk to lives here. */
  | 'known'
  /** Derived from our own network position. */
  | 'likely'
  /** A common default. We are guessing. */
  | 'guess';

export interface SubnetSuggestion {
  subnet: string;
  reason: string;
  confidence: SubnetConfidence;
}

export interface SubnetInputs {
  /** Addresses of devices already adopted — the strongest evidence there is. */
  deviceHosts?: Array<string | null | undefined>;
  /** Configured gateway addresses (DTU, charger). */
  configuredHosts?: Array<string | null | undefined>;
}

/**
 * Rank the subnets worth scanning, with a reason for each.
 *
 * The scan takes one /24, and until now the UI simply asserted one — so a house with
 * an IoT VLAN or a separate guest network could scan forever and find nothing, with
 * no way to tell "there is nothing there" from "we are looking at the wrong network".
 *
 * The ordering matters more than the list. An adopted device's address is proof that
 * a subnet contains smart devices; our own interface is an inference; a common
 * default is a guess. Presenting all three identically is what made the old single
 * suggestion feel authoritative when it was often just `192.168.1`.
 */
export function subnetSuggestions(inputs: SubnetInputs = {}): SubnetSuggestion[] {
  const out: SubnetSuggestion[] = [];
  const seen = new Set<string>();
  const add = (subnet: string | null, reason: string, confidence: SubnetConfidence): void => {
    if (!subnet || seen.has(subnet)) return;
    seen.add(subnet);
    out.push({ subnet, reason, confidence });
  };

  // Strongest first: we are already talking to something here.
  const deviceSubnets = new Map<string, number>();
  for (const host of inputs.deviceHosts ?? []) {
    const subnet = subnetOf(host);
    if (subnet) deviceSubnets.set(subnet, (deviceSubnets.get(subnet) ?? 0) + 1);
  }
  for (const [subnet, count] of [...deviceSubnets.entries()].sort((a, b) => b[1] - a[1])) {
    add(subnet, `${count} adopted device${count === 1 ? '' : 's'} here`, 'known');
  }

  for (const host of inputs.configuredHosts ?? []) {
    add(subnetOf(host), 'your configured gateway is here', 'known');
  }

  add(detectLanSubnet(), 'this server’s own network', 'likely');

  for (const subnet of COMMON_SUBNETS) {
    add(subnet, 'a common home default', 'guess');
  }

  return out;
}

/** Just the subnets, best first — for callers that only need a default. */
export function suggestedSubnets(inputs: SubnetInputs = {}): string[] {
  return subnetSuggestions(inputs).map((s) => s.subnet);
}
