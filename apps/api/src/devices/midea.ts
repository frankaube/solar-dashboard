import * as dgram from 'node:dgram';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

/**
 * Midea LAN discovery — and, deliberately, only discovery.
 *
 * Covers Midea and the many brands on the same hardware: Senville, Pioneer, Carrier,
 * Toshiba (North America), Klimaire. Discovery needs no credential at all: devices
 * answer a fixed broadcast, and the reply is encrypted with a PUBLISHED CONSTANT key
 * that is neither per-device nor cloud-derived. Four independent implementations agree
 * on it byte for byte.
 *
 * WHAT THIS DOES NOT DO, on purpose: read energy. Midea AC units can report energy
 * over the control plane, but that path needs a V3 token from a cloud round-trip that
 * Midea is actively shutting down — and, more damningly, the returned bytes have two
 * incompatible decodings (BCD and binary) that NO existing library disambiguates. The
 * capability byte that would settle it is parsed by several projects and read by none.
 * Shipping that would mean showing a figure that could be wrong by a factor of 100, so
 * this finds the device and says nothing about its consumption.
 */

/** Published constant. Not a secret, not per-device, does not rotate. */
const SIGN_KEY = 'xhdiwjnchekd4d512chdjx5d8e4c394D2D7S';
const ENC_KEY = createHash('md5').update(SIGN_KEY).digest();

const PORTS = [6445, 20086];
const DEFAULT_LISTEN_MS = 3_000;
/** UDP is lossy and this is a one-shot ask, so the probe goes out more than once. */
const PROBE_REPEATS = 3;

/**
 * The 72-byte discovery probe, built rather than pasted.
 *
 * Every implementation ships this as an opaque hex blob. Constructing it from its
 * parts documents what it actually is — and means a transcription slip in a 144-character
 * string cannot silently produce a probe that no device answers.
 */
export function buildDiscoveryProbe(): Buffer {
  const header = Buffer.alloc(40);
  Buffer.from([0x5a, 0x5a, 0x01, 0x11, 0x48, 0x00, 0x92, 0x00]).copy(header, 0);

  // The body is a fixed two-byte payload, PKCS7-padded and encrypted. Because the
  // plaintext never varies, the ciphertext is constant too.
  const cipher = createCipheriv('aes-128-ecb', ENC_KEY, null);
  cipher.setAutoPadding(false);
  const padded = Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.alloc(14, 14)]);
  const body = Buffer.concat([cipher.update(padded), cipher.final()]);

  const withoutSig = Buffer.concat([header, body]);
  const signature = createHash('md5')
    .update(Buffer.concat([withoutSig, Buffer.from(SIGN_KEY, 'ascii')]))
    .digest();
  return Buffer.concat([withoutSig, signature]);
}

export interface MideaDevice {
  host: string;
  /** TCP port for the control plane. Not used here; recorded for later. */
  port: number;
  serialNumber: string;
  /** e.g. `net_ac_9F3C` — also the fallback source for the device type. */
  ssid: string;
  /** 0xAC air conditioner, 0xA1 dehumidifier, 0xCD heat-pump water heater, … */
  deviceType: number | null;
  mac: string | null;
  firmware: string | null;
  /** 2 or 3. Decides whether control would need a cloud token — 3 does. */
  protocolVersion: 2 | 3;
}

/**
 * Find the inner `5a5a` packet and honour its own length field.
 *
 * V3 replies wrap the same packet in an `8370` envelope. Slicing from the end with
 * negative offsets — which most implementations do — breaks the moment a datagram
 * carries trailing bytes, so this locates the real packet instead of assuming it runs
 * to the end of the buffer.
 */
export function findInnerPacket(data: Buffer): { packet: Buffer; version: 2 | 3 } | null {
  if (data.length < 8) return null;
  const magic = data.readUInt16BE(0);
  // 0x5a5a = V2 outer packet; 0x8370 = V3 envelope, inner packet starts 8 bytes in.
  const start = magic === 0x5a5a ? 0 : magic === 0x8370 ? 8 : -1;
  if (start < 0) return null;
  if (data.length < start + 6) return null;
  if (data.readUInt16BE(start) !== 0x5a5a) return null;
  const length = data.readUInt16LE(start + 4);
  if (length < 56 || start + length > data.length) return null;
  return { packet: data.subarray(start, start + length), version: start === 0 ? 2 : 3 };
}

/** Read a fixed-width ASCII field, stopping at the first NUL. */
function ascii(data: Buffer, from: number, to: number): string {
  if (to > data.length) return '';
  const raw = data.subarray(from, to).toString('ascii');
  const nul = raw.indexOf('\0');
  return (nul >= 0 ? raw.slice(0, nul) : raw).trim();
}

/**
 * Parse one discovery reply.
 *
 * Every read past the SSID is length-guarded, because real units send shorter replies
 * than the full layout — the reference implementations guard these for exactly that
 * reason. A short reply should yield a device with unknown extras, never an exception
 * that loses the whole sweep.
 */
export function parseDiscoveryReply(data: Buffer): MideaDevice | null {
  const inner = findInnerPacket(data);
  if (!inner) return null;
  const { packet, version } = inner;

  const body = packet.subarray(40, packet.length - 16);
  if (body.length === 0 || body.length % 16 !== 0) return null;

  let payload: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-ecb', ENC_KEY, null);
    decipher.setAutoPadding(false);
    payload = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
  if (payload.length < 41) return null;

  // The advertised address can be stale after a DHCP change; the caller prefers the
  // address the datagram actually came from and uses this only as a fallback.
  const ip = `${payload[3]}.${payload[2]}.${payload[1]}.${payload[0]}`;
  const port = payload.readUInt16LE(4);
  const serialNumber = ascii(payload, 8, 40);

  const ssidLength = payload[40];
  const ssid = ascii(payload, 41, 41 + ssidLength);
  const after = 41 + ssidLength;
  if (ssid.length === 0) return null;

  /*
    Device type has two sources and needs both. Three of the four reference
    implementations read it ONLY from the SSID (`net_ac_9F3C` -> 0xac); one reads a
    byte and falls back to the SSID. The byte is absent or zero on some units, so
    taking the superset is what actually works across the fleet.
  */
  const typeByte = after + 14 < payload.length ? payload[after + 14] : 0;
  const fromSsid = Number.parseInt(ssid.split('_')[1] ?? '', 16);
  const deviceType = typeByte || (Number.isNaN(fromSsid) ? null : fromSsid);

  const macStart = after + 22;
  const mac =
    macStart + 6 <= payload.length
      ? [...payload.subarray(macStart, macStart + 6)]
          .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
          .join(':')
      : // Some replies carry it inside the serial instead.
        (serialNumber.length >= 32 ? serialNumber.slice(16, 32) : null);

  const fwStart = after + 31;
  const firmware =
    fwStart + 3 <= payload.length
      ? `${payload[fwStart]}.${payload[fwStart + 1]}.${payload[fwStart + 2]}`
      : null;

  return {
    host: ip,
    port,
    serialNumber,
    ssid,
    deviceType,
    mac,
    firmware,
    protocolVersion: version,
  };
}

/** Human label for the types worth telling apart. */
export function describeDeviceType(type: number | null): string {
  switch (type) {
    case 0xac:
      return 'air conditioner';
    case 0xa1:
      return 'dehumidifier';
    case 0xcd:
      return 'heat-pump water heater';
    case 0xc3:
      return 'heat-pump controller';
    case 0xfa:
      return 'fan';
    case 0xfd:
      return 'humidifier';
    default:
      return 'device';
  }
}

/**
 * Broadcast on both discovery ports and collect the replies.
 *
 * Active rather than passive — these do not announce themselves unprompted. As with
 * every other broadcast probe here, this hears nothing from inside a Docker bridge
 * network; there is no TCP fallback because a bare open port on 6444 identifies
 * nothing without the control-plane handshake.
 */
export function sweepMidea(listenMs = DEFAULT_LISTEN_MS): Promise<MideaDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, MideaDevice>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const probe = buildDiscoveryProbe();

    socket.on('message', (msg, rinfo) => {
      const device = parseDiscoveryReply(msg);
      if (!device) return;
      // Trust the source address over the advertised one.
      found.set(device.serialNumber || rinfo.address, { ...device, host: rinfo.address });
    });
    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve([...found.values()]);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        for (let i = 0; i < PROBE_REPEATS; i++) {
          for (const port of PORTS) {
            socket.send(probe, port, '255.255.255.255');
          }
        }
      } catch {
        /* no broadcast permission — nothing to be done */
      }
    });

    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    }, listenMs);
  });
}
