import * as net from 'node:net';

/**
 * Adding a device by address, when discovery cannot see it. A Tuya plug announces itself
 * over UDP broadcast, which a bridged Docker container never receives because broadcasts
 * are link-local, while unicast TCP to the same address from it connects immediately.
 */

const PROBE_TIMEOUT_MS = 4_000;

/** What a vendor listens on, and what we can honestly promise once connected. */
export interface ManualVendor {
  id: string;
  name: string;
  kind: string;
  port: number;
  /**
   * Whether reaching the device is enough to read from it. False for Tuya: 3.3 encrypts
   * everything with a per-device localKey only Tuya's cloud issues, so a connection proves
   * the plug is there and nothing more.
   */
  readableWithoutCredentials: boolean;
  credentialLabel: string | null;
  /**
   * Whether the hardware can report watts at all — a separate question from whether it can
   * be talked to. A flag rather than prose, so the UI can state it for every vendor.
   */
  metersEnergy: boolean;
  note: string | null;
}

export const MANUAL_VENDORS: ManualVendor[] = [
  {
    id: 'tuya',
    // Short enough for a dropdown in a 420px column; brands go in the note, which wraps.
    name: 'Tuya / Smart Life plug',
    kind: 'plug',
    port: 6668,
    readableWithoutCredentials: false,
    credentialLabel: 'Local key',
    metersEnergy: false,
    // The add flow asks for a rating right after adding, so the note does not repeat it.
    note: 'Covers Prime and most white-label brands. Tuya encrypts local traffic with a key only its cloud issues, so without one the plug can be listed but not switched.',
  },
  {
    id: 'kasa',
    name: 'TP-Link Kasa',
    kind: 'switch',
    port: 9999,
    readableWithoutCredentials: true,
    credentialLabel: null,
    // Only KP115 and HS110 report watts, and they are indistinguishable from a plain HS100
    // until one produces a reading.
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
 * Reject anything that is not plausibly a host before opening a socket, so a typo is
 * refused rather than turned into a four-second timeout.
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
