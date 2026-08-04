import * as net from 'node:net';

/**
 * Adding a device by address, when discovery cannot see it.
 *
 * Discovery and reachability are different problems, and conflating them is what makes a
 * device "not supported" when it is merely unheard. On this install a Tuya plug at
 * 10.0.0.115 announces itself over UDP broadcast, the host hears it twice in fourteen
 * seconds, and the app — in a bridged Docker container on 172.18.0.0/16 — hears nothing,
 * because broadcasts are link-local and a bridge does not carry them.
 *
 * But TCP to that same address from that same container connects immediately: unicast is
 * routed. So the device was always reachable and never findable, and typing the address in
 * is a complete fix rather than a workaround.
 */

const PROBE_TIMEOUT_MS = 4_000;

/** What a vendor listens on, and what we can honestly promise once connected. */
export interface ManualVendor {
  id: string;
  name: string;
  kind: string;
  port: number;
  /**
   * Whether reaching the device is enough to read from it.
   *
   * False for Tuya: protocol 3.3 encrypts everything with a per-device localKey that only
   * Tuya's cloud will issue, so a successful connection proves the plug is there and
   * nothing more. Saying so is the difference between an honest entry and a device that
   * sits in the list forever showing no data.
   */
  readableWithoutCredentials: boolean;
  credentialLabel: string | null;
  /**
   * Whether the hardware can report watts at all.
   *
   * A separate question from whether we can talk to it, and for an energy dashboard it
   * outranks the other two: a device we can see and switch but never measure contributes
   * nothing to the thing this app is for. Kept as a flag rather than a sentence so the UI
   * can say it for any vendor instead of only where someone remembered to write prose.
   */
  metersEnergy: boolean;
  note: string | null;
}

export const MANUAL_VENDORS: ManualVendor[] = [
  {
    id: 'tuya',
    // Short enough for a dropdown in a 420px column. The brand list belongs in the note,
    // where it can wrap, rather than in a label that gets clipped mid-word.
    name: 'Tuya / Smart Life plug',
    kind: 'plug',
    port: 6668,
    readableWithoutCredentials: false,
    credentialLabel: 'Local key',
    metersEnergy: false,
    // Short, and no longer telling anyone to look "above" — the add flow asks for a
    // rating itself, right after adding, and the meter caveat is stated on its own line.
    note: 'Covers Prime and most white-label brands. Tuya encrypts local traffic with a key only its cloud issues, so without one the plug can be listed but not switched.',
  },
  {
    id: 'kasa',
    name: 'TP-Link Kasa',
    kind: 'switch',
    port: 9999,
    readableWithoutCredentials: true,
    credentialLabel: null,
    // Only the energy-monitoring models (KP115, HS110) report watts; a plain HS100 or a
    // wall switch does not, and they are indistinguishable until one produces a reading.
    metersEnergy: false,
    note: 'Only the KP115 and HS110 report watts. Plain switches do not.',
  },
  {
    id: 'shelly',
    name: 'Shelly',
    kind: 'plug',
    port: 80,
    readableWithoutCredentials: true,
    credentialLabel: null,
    metersEnergy: true,
    note: null,
  },
  {
    id: 'tasmota',
    name: 'Tasmota',
    kind: 'plug',
    port: 80,
    readableWithoutCredentials: true,
    credentialLabel: null,
    metersEnergy: true,
    note: null,
  },
  {
    id: 'goe',
    name: 'go-e Charger',
    kind: 'charger',
    port: 80,
    readableWithoutCredentials: true,
    credentialLabel: null,
    metersEnergy: true,
    note: null,
  },
];

export function findManualVendor(id: string): ManualVendor | undefined {
  return MANUAL_VENDORS.find((vendor) => vendor.id === id);
}

const HOST_PATTERN = /^[a-zA-Z0-9.\-]{1,253}$/;

/**
 * Reject anything that is not plausibly a host before opening a socket.
 *
 * The value goes straight into a connection attempt, so this is the boundary where a
 * typo should be refused rather than turned into a four-second timeout.
 */
export function validHost(host: string): boolean {
  return HOST_PATTERN.test(host.trim()) && host.trim().length > 0;
}

/** Does something answer on that port? A plain TCP connect, nothing vendor-specific. */
export function probePort(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/** A name to show until the owner renames it, or the device tells us its own. */
export function defaultName(vendor: ManualVendor, host: string): string {
  return `${vendor.name.split(' ')[0]} at ${host}`;
}
