import * as dgram from 'node:dgram';
import { createDecipheriv, createHash } from 'node:crypto';

/**
 * Tuya LAN discovery.
 *
 * Tuya is the platform behind a large share of the white-label smart plugs sold in
 * North America — "Prime", and many other names on the same hardware. The scan used
 * to miss all of them, because it probed TCP 9999 (Kasa), TCP 80 (Shelly/Tasmota/
 * ESPHome) and mDNS `_hap._tcp` (HomeKit), and a Tuya device answers none of those.
 * It listens on TCP 6668 and announces itself over UDP instead.
 *
 * Discovery needs no cloud account and no credentials: devices broadcast every few
 * seconds, and the encryption key for the 6667 announcements is a documented
 * constant. CONTROL is a different matter — that needs a per-device `localKey` which
 * only Tuya's cloud will hand over, and which rotates when the device is re-paired.
 * So this module finds devices honestly and promises nothing about talking to them.
 */

/** Documented constant for the encrypted 6667 announcements. Not a secret. */
const UDP_KEY = createHash('md5').update('yGAdlopoPVldABfn').digest();
const PORTS = [6666, 6667];
const DEFAULT_LISTEN_MS = 8_000;

export interface TuyaDevice {
  host: string;
  /** Tuya device id. Stable across reboots; the closest thing to a hardware id. */
  gwId: string;
  /** Protocol version, e.g. "3.3" — decides the local control dialect. */
  version: string;
  productKey?: string;
  /** True when local traffic is encrypted, i.e. control needs the localKey. */
  encrypted: boolean;
}

interface TuyaAnnouncement {
  ip?: string;
  gwId?: string;
  version?: string;
  productKey?: string;
  encrypt?: boolean;
}

/**
 * Pull the JSON out of one broadcast frame.
 *
 * Frames are `55AA <header> <payload> <crc> 0000AA55`. The header length differs
 * between the plain (6666) and encrypted (6667) forms, and firmware versions vary,
 * so rather than hard-code one offset this tries the known framings and falls back to
 * locating the JSON directly. Returns null for anything unrecognisable — a malformed
 * or foreign packet on a shared port must not take the sweep down.
 */
export function parseTuyaBroadcast(buf: Buffer): TuyaAnnouncement | null {
  const asJson = (text: string): TuyaAnnouncement | null => {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as TuyaAnnouncement;
    } catch {
      return null;
    }
  };

  // Unencrypted (6666, and some 6667 firmwares): the JSON is already in the frame.
  const plain = asJson(buf.toString('utf8'));
  if (plain?.gwId) return plain;

  // Encrypted (6667): strip framing and decrypt. 20 is the common offset (header +
  // return code); 16 covers frames without it.
  for (const offset of [20, 16]) {
    if (buf.length <= offset + 8) continue;
    const body = buf.subarray(offset, buf.length - 8);
    if (body.length % 16 !== 0) continue; // not an AES block boundary
    try {
      const decipher = createDecipheriv('aes-128-ecb', UDP_KEY, null);
      decipher.setAutoPadding(false);
      const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      const parsed = asJson(text);
      if (parsed?.gwId) return parsed;
    } catch {
      /* wrong offset — try the next */
    }
  }
  return null;
}

/**
 * Listen for announcements on both Tuya broadcast ports.
 *
 * Passive: it sends nothing. Devices broadcast on their own schedule (a few seconds),
 * so the window only has to be long enough to catch one round.
 *
 * A port already in use is not an error worth failing the scan for — Home Assistant
 * or another tool may hold it — so a bind failure degrades to "found nothing on that
 * port" and the caller still gets whatever the other port heard.
 */
export function sweepTuya(listenMs = DEFAULT_LISTEN_MS): Promise<TuyaDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, TuyaDevice>();
    const sockets: dgram.Socket[] = [];

    for (const port of PORTS) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('message', (msg, rinfo) => {
        const announcement = parseTuyaBroadcast(msg);
        if (!announcement?.gwId) return;
        // Prefer the address we received it from; the advertised `ip` can be stale
        // after a DHCP change while the device keeps announcing the old one.
        const host = rinfo.address || announcement.ip || '';
        if (!host) return;
        found.set(announcement.gwId, {
          host,
          gwId: announcement.gwId,
          version: announcement.version ?? 'unknown',
          productKey: announcement.productKey,
          encrypted: announcement.encrypt !== false,
        });
      });
      socket.on('error', () => {
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      });
      try {
        socket.bind(port);
        sockets.push(socket);
      } catch {
        /* port unavailable — carry on with the other */
      }
    }

    setTimeout(() => {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      resolve([...found.values()]);
    }, listenMs);
  });
}
