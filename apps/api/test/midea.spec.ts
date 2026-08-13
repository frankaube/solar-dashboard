import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryProbe,
  describeDeviceType,
  findInnerPacket,
  parseDiscoveryReply,
} from '../src/devices/midea';

const SIGN_KEY = 'xhdiwjnchekd4d512chdjx5d8e4c394D2D7S';
const ENC_KEY = createHash('md5').update(SIGN_KEY).digest();

/** Build a discovery reply the way a device does, so the parser meets real framing. */
function reply(
  opts: {
    ip?: [number, number, number, number];
    port?: number;
    sn?: string;
    ssid?: string;
    typeByte?: number;
    mac?: number[];
    firmware?: [number, number, number];
    v3?: boolean;
    truncateAfterSsid?: boolean;
  } = {},
): Buffer {
  const {
    ip = [10, 0, 0, 77],
    port = 6444,
    sn = '000000P0000000Q1123456789ABCDEF0',
    ssid = 'net_ac_9F3C',
    typeByte = 0xac,
    mac = [0xd0, 0xc5, 0xd3, 0x11, 0x22, 0x33],
    firmware = [3, 0, 8],
    v3 = false,
    truncateAfterSsid = false,
  } = opts;

  const payload = Buffer.alloc(truncateAfterSsid ? 41 + ssid.length : 120);
  // IP is stored reversed on the wire.
  payload[0] = ip[3];
  payload[1] = ip[2];
  payload[2] = ip[1];
  payload[3] = ip[0];
  payload.writeUInt16LE(port, 4);
  payload.write(sn.padEnd(32, '\0'), 8, 32, 'ascii');
  payload[40] = ssid.length;
  payload.write(ssid, 41, ssid.length, 'ascii');
  if (!truncateAfterSsid) {
    const after = 41 + ssid.length;
    payload[after + 14] = typeByte;
    Buffer.from(mac).copy(payload, after + 22);
    payload[after + 31] = firmware[0];
    payload[after + 32] = firmware[1];
    payload[after + 33] = firmware[2];
  }

  const cipher = createCipheriv('aes-128-ecb', ENC_KEY, null);
  cipher.setAutoPadding(false);
  const padLen = 16 - (payload.length % 16 || 16);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.alloc(padLen, padLen)])),
    cipher.final(),
  ]);

  const header = Buffer.alloc(40);
  header.writeUInt16BE(0x5a5a, 0);
  header.writeUInt16LE(40 + body.length + 16, 4);
  const inner = Buffer.concat([header, body, Buffer.alloc(16)]);
  if (!v3) return inner;
  // V3 wraps the same packet in an 8370 envelope: 8 bytes front, 16 back.
  const envelope = Buffer.alloc(8);
  envelope.writeUInt16BE(0x8370, 0);
  return Buffer.concat([envelope, inner, Buffer.alloc(16)]);
}

describe('discovery probe', () => {
  it('is 72 bytes with the documented header', () => {
    // Built from its parts rather than pasted as hex, so this pins the construction:
    // a 40-byte header, a 16-byte encrypted fixed body, a 16-byte signature.
    const probe = buildDiscoveryProbe();
    expect(probe).toHaveLength(72);
    expect(probe.subarray(0, 8).toString('hex')).toBe('5a5a011148009200');
    // Bytes 4-5 are the length field: 0x0048 = 72, matching the packet's own size.
    expect(probe.readUInt16LE(4)).toBe(72);
  });

  it('carries a signature over everything before it', () => {
    const probe = buildDiscoveryProbe();
    const expected = createHash('md5')
      .update(Buffer.concat([probe.subarray(0, 56), Buffer.from(SIGN_KEY, 'ascii')]))
      .digest();
    expect(probe.subarray(56)).toEqual(expected);
  });

  it('is stable — the payload never varies, so neither does the packet', () => {
    expect(buildDiscoveryProbe()).toEqual(buildDiscoveryProbe());
  });

  it('reproduces the constant every other implementation ships', () => {
    /*
      The load-bearing test. Four independent projects — msmart-ng,
      homebridge-midea-platform, midea-beautiful-air, midea-local — ship this probe as
      an opaque hex blob. Building it from its parts and arriving at the same 32 bytes
      confirms the key, the PKCS7 padding and the signature algorithm simultaneously.

      If any of those were wrong the packet would still be 72 bytes and still look
      plausible, and no device would ever answer it. That is precisely the failure
      this project keeps finding, so it gets an assertion rather than a comment.
    */
    const tail = buildDiscoveryProbe().subarray(40).toString('hex');
    expect(tail).toBe('7f75bd6b3e4f8b762e849c6e578d6590036e9d4342a50f1f569eb8ec918e92e5');
  });
});

describe('parseDiscoveryReply', () => {
  it('reads a V2 reply', () => {
    const d = parseDiscoveryReply(reply())!;
    expect(d).toMatchObject({
      host: '10.0.0.77',
      port: 6444,
      ssid: 'net_ac_9F3C',
      deviceType: 0xac,
      protocolVersion: 2,
      firmware: '3.0.8',
      mac: 'D0:C5:D3:11:22:33',
    });
  });

  it('reads a V3 reply identically', () => {
    // The 8370 envelope wraps the same inner packet; both must yield the same device.
    const v2 = parseDiscoveryReply(reply())!;
    const v3 = parseDiscoveryReply(reply({ v3: true }))!;
    expect({ ...v3, protocolVersion: 2 }).toEqual(v2);
    expect(v3.protocolVersion).toBe(3);
  });

  it('unreverses the IP', () => {
    // Stored little-endian-ish on the wire; reading it forwards gives 77.0.0.10.
    expect(parseDiscoveryReply(reply({ ip: [192, 168, 4, 20] }))!.host).toBe('192.168.4.20');
  });

  it('falls back to the SSID when the type byte is absent', () => {
    // Three of four reference implementations read the type ONLY from the SSID,
    // because the byte is zero on plenty of real units.
    const d = parseDiscoveryReply(reply({ typeByte: 0 }))!;
    expect(d.deviceType).toBe(0xac);
  });

  it('prefers the type byte when the SSID disagrees', () => {
    const d = parseDiscoveryReply(reply({ typeByte: 0xa1, ssid: 'net_ac_9F3C' }))!;
    expect(d.deviceType).toBe(0xa1);
  });

  it('survives a reply that stops after the SSID', () => {
    // Real units send shorter replies than the full layout. A short one must yield a
    // device with unknown extras, not an exception that loses the whole sweep.
    const d = parseDiscoveryReply(reply({ truncateAfterSsid: true }))!;
    expect(d.ssid).toBe('net_ac_9F3C');
    expect(d.host).toBe('10.0.0.77');
    expect(d.firmware).toBeNull();
  });

  it('honours the packet length rather than slicing from the end', () => {
    // Most implementations use negative offsets, which break the moment a datagram
    // carries trailing bytes. This locates the real packet instead.
    const withJunk = Buffer.concat([reply(), Buffer.from('trailing rubbish')]);
    expect(parseDiscoveryReply(withJunk)!.host).toBe('10.0.0.77');
  });

  it('rejects anything that is not a Midea reply', () => {
    expect(parseDiscoveryReply(Buffer.alloc(0))).toBeNull();
    expect(parseDiscoveryReply(Buffer.from('hello world'))).toBeNull();
    expect(parseDiscoveryReply(Buffer.alloc(200))).toBeNull();
  });

  it('rejects a truncated packet rather than reading past it', () => {
    expect(parseDiscoveryReply(reply().subarray(0, 30))).toBeNull();
  });

  it('rejects a reply whose SSID is empty', () => {
    // Without it there is neither a name nor a type fallback, so there is nothing
    // worth putting in front of someone.
    expect(parseDiscoveryReply(reply({ ssid: '' }))).toBeNull();
  });
});

describe('findInnerPacket', () => {
  it('recognises both framings', () => {
    expect(findInnerPacket(reply())!.version).toBe(2);
    expect(findInnerPacket(reply({ v3: true }))!.version).toBe(3);
  });

  it('refuses an implausible length field', () => {
    // A misread length must not become an out-of-range slice.
    const bad = reply();
    bad.writeUInt16LE(9999, 4);
    expect(findInnerPacket(bad)).toBeNull();
  });
});

describe('describeDeviceType', () => {
  it('names the types worth telling apart', () => {
    expect(describeDeviceType(0xac)).toBe('air conditioner');
    expect(describeDeviceType(0xcd)).toBe('heat-pump water heater');
  });

  it('says "device" rather than guessing at an unknown code', () => {
    expect(describeDeviceType(0x99)).toBe('device');
    expect(describeDeviceType(null)).toBe('device');
  });
});
