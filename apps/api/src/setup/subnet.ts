import { networkInterfaces } from 'node:os';

/** Docker bridge networks (container-internal, never the user's LAN). */
function isDockerBridge(ip: string): boolean {
  return /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

export function subnetOf(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const match = ip.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  return match ? match[1] : null;
}

/** Best guess at the LAN /24. A container's Docker bridge says nothing about the user's gear. */
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
  /** Something already reachable lives here. */
  | 'known'
  /** Derived from this server's own network position. */
  | 'likely'
  /** A common default — a guess. */
  | 'guess';

export interface SubnetSuggestion {
  subnet: string;
  reason: string;
  confidence: SubnetConfidence;
}

export interface SubnetInputs {
  /** Addresses of devices already adopted — the strongest evidence. */
  deviceHosts?: Array<string | null | undefined>;
  /** Configured gateway addresses (DTU, charger). */
  configuredHosts?: Array<string | null | undefined>;
}

/**
 * The scan takes one /24, so a house with an IoT VLAN needs more than one candidate. Order is
 * the point: an adopted device's address proves a subnet holds smart devices, this server's
 * own interface is an inference, a common default is a guess.
 */
export function subnetSuggestions(inputs: SubnetInputs = {}): SubnetSuggestion[] {
  const out: SubnetSuggestion[] = [];
  const seen = new Set<string>();
  const add = (subnet: string | null, reason: string, confidence: SubnetConfidence): void => {
    if (!subnet || seen.has(subnet)) return;
    seen.add(subnet);
    out.push({ subnet, reason, confidence });
  };

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
