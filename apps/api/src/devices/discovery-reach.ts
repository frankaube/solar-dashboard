/**
 * Can this process actually see the LAN it is trying to scan?
 *
 * Unicast discovery works from anywhere that can route to the subnet. Broadcast and
 * multicast discovery — Tuya over UDP, mDNS on 224.0.0.251 — is link-local and does not
 * cross a Docker bridge, so a bridged container gets an empty list rather than an error,
 * indistinguishable from "you have no such devices". Comparing our own interfaces against
 * an address already known to work tells the two apart.
 */

export interface Interface {
  address: string;
  netmask: string;
  internal: boolean;
  /** Node has reported this as both "IPv4" and 4 across versions; accept either. */
  family: string | number;
}

export interface DiscoveryReach {
  /** True when some local interface shares a subnet with the devices we know about. */
  onDeviceSubnet: boolean;
  /** Non-loopback IPv4 subnets this process is actually on, e.g. "172.18.0.0/16". */
  localSubnets: string[];
  /** The subnet the known devices live on, when one is known. */
  deviceSubnet: string | null;
  /**
   * Why broadcast discovery will find nothing, or null when it should work. Phrased for
   * someone looking at an empty device list.
   */
  broadcastBlindReason: string | null;
}

function toLong(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function prefixLength(netmask: string): number {
  const long = toLong(netmask);
  if (long === null) return 0;
  return long.toString(2).split('1').length - 1;
}

function subnetOf(address: string, netmask: string): string | null {
  const ip = toLong(address);
  const mask = toLong(netmask);
  if (ip === null || mask === null) return null;
  const network = (ip & mask) >>> 0;
  const octets = [network >>> 24, (network >>> 16) & 255, (network >>> 8) & 255, network & 255];
  return `${octets.join('.')}/${prefixLength(netmask)}`;
}

function sameSubnet(address: string, netmask: string, other: string): boolean {
  const ip = toLong(address);
  const mask = toLong(netmask);
  const target = toLong(other);
  if (ip === null || mask === null || target === null) return false;
  return ((ip & mask) >>> 0) === ((target & mask) >>> 0);
}

/**
 * @param interfaces what `os.networkInterfaces()` reports, flattened
 * @param knownDeviceHost an address already talked to successfully; the gateway is ideal,
 *        being both reachable and certainly on the network the owner wants scanned
 */
export function assessDiscoveryReach(
  interfaces: Interface[],
  knownDeviceHost: string | null,
): DiscoveryReach {
  const usable = interfaces.filter((i) => !i.internal && (i.family === 'IPv4' || i.family === 4));
  const localSubnets = [
    ...new Set(usable.map((i) => subnetOf(i.address, i.netmask)).filter((s): s is string => Boolean(s))),
  ];

  if (!knownDeviceHost) {
    // Nothing configured yet, so there is nothing to compare against and no claim to make.
    return { onDeviceSubnet: true, localSubnets, deviceSubnet: null, broadcastBlindReason: null };
  }

  const match = usable.find((i) => sameSubnet(i.address, i.netmask, knownDeviceHost));
  const deviceSubnet = match ? subnetOf(match.address, match.netmask) : null;
  if (match) {
    return { onDeviceSubnet: true, localSubnets, deviceSubnet, broadcastBlindReason: null };
  }

  return {
    onDeviceSubnet: false,
    localSubnets,
    deviceSubnet: null,
    broadcastBlindReason:
      `This process is on ${localSubnets.join(', ') || 'no LAN interface'}, but your equipment is on the ` +
      `network containing ${knownDeviceHost}. Scans that probe addresses directly still work, because they ` +
      `are routed. Scans that listen for announcements — Tuya plugs, mDNS, HomeKit — cannot, because those ` +
      `are broadcast only to the local link and a Docker bridge does not carry them. Devices found that way ` +
      `will be missing with no error to show for it. Running the app directly on the host, or with host ` +
      `networking, is what makes them visible.`,
  };
}
