import { createCipheriv, createDecipheriv } from 'node:crypto';
import { crc32 } from 'node:zlib';

/**
 * Tuya's local protocol, enough of it to read a switch and flip one.
 *
 * Discovery already works without any of this — the UDP announcement is encrypted with a
 * key every Tuya device shares, which is why a plug can be found and named with no
 * credentials at all. Control is the opposite: every frame is encrypted with a key issued
 * per device by Tuya's cloud, and there is no local way to obtain it. That is the whole
 * reason the Devices page says "found, not readable".
 *
 * FRAME LAYOUT (v3.1–v3.4)
 *
 *   0x000055AA  prefix
 *   uint32      sequence
 *   uint32      command
 *   uint32      length of everything after this field
 *   ...payload
 *   uint32      CRC32 over prefix..payload
 *   0x0000AA55  suffix
 *
 * The version differences are all in the payload, not the frame, and 3.3 is what the
 * overwhelming majority of plugs speak. 3.4 and 3.5 changed the handshake substantially
 * and are deliberately refused rather than half-supported — a device that negotiates
 * differently and is told "wrong password" is a worse outcome than one that is told
 * plainly it is not supported.
 */

const PREFIX = 0x000055aa;
const SUFFIX = 0x0000aa55;

export const TUYA_CONTROL_PORT = 6668;

export const CMD = {
  /** Read the current datapoints. */
  DP_QUERY: 0x0a,
  /** Set datapoints. */
  CONTROL: 0x07,
} as const;

/** Versions this speaks. Anything else is refused by name. */
export const SUPPORTED_VERSIONS = ['3.1', '3.3'] as const;
export type TuyaVersion = (typeof SUPPORTED_VERSIONS)[number];

export function isSupportedVersion(version: string): version is TuyaVersion {
  return (SUPPORTED_VERSIONS as readonly string[]).includes(version);
}

/**
 * A local key is 16 ASCII characters, used directly as the AES-128 key.
 *
 * Checked before use because the failure otherwise is a decrypt error deep inside a
 * response, which reads as "the device rejected us" rather than "that is not a key".
 */
export function isPlausibleLocalKey(key: string): boolean {
  return /^[\x20-\x7e]{16}$/.test(key);
}

function encrypt(payload: Buffer, key: string): Buffer {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(key, 'ascii'), null);
  return Buffer.concat([cipher.update(payload), cipher.final()]);
}

export function decrypt(payload: Buffer, key: string): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key, 'ascii'), null);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

/**
 * Wrap a payload in the frame.
 *
 * The length field counts the payload plus the CRC and suffix, not the header — a detail
 * that is easy to get wrong and produces a device that simply never answers, with no error
 * to read.
 */
export function encode(command: number, payload: Buffer, sequence = 1): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(PREFIX, 0);
  header.writeUInt32BE(sequence, 4);
  header.writeUInt32BE(command, 8);
  header.writeUInt32BE(payload.length + 8, 12);

  const body = Buffer.concat([header, payload]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32BE(crc32(body) >>> 0, 0);
  tail.writeUInt32BE(SUFFIX, 4);
  return Buffer.concat([body, tail]);
}

export interface TuyaFrame {
  sequence: number;
  command: number;
  /** Return code, present on responses. 0 means success. */
  returnCode: number | null;
  payload: Buffer;
}

/**
 * Pull frames out of a stream.
 *
 * Returns every complete frame found and how many bytes were consumed, because a single
 * read can carry two frames or half of one — a plug answers a query and pushes a status
 * update in the same breath often enough that assuming one frame per packet fails
 * intermittently, which is the worst way for it to fail.
 */
export function decode(buffer: Buffer): { frames: TuyaFrame[]; consumed: number } {
  const frames: TuyaFrame[] = [];
  let offset = 0;

  while (offset + 20 <= buffer.length) {
    if (buffer.readUInt32BE(offset) !== PREFIX) {
      // Resynchronise rather than giving up: a stray byte would otherwise poison the
      // connection for as long as it stays open.
      const next = buffer.indexOf('000055aa', offset, 'hex');
      if (next < 0) return { frames, consumed: buffer.length };
      offset = next;
      continue;
    }
    const length = buffer.readUInt32BE(offset + 12);
    const total = 16 + length;
    if (offset + total > buffer.length) break; // partial frame, wait for more

    const sequence = buffer.readUInt32BE(offset + 4);
    const command = buffer.readUInt32BE(offset + 8);
    let body = buffer.subarray(offset + 16, offset + total - 8);

    /*
      Responses carry a 4-byte return code before the payload; requests do not. Telling
      them apart by looking is unreliable, so this uses the shape the device actually
      sends: a non-zero code is an error and the payload after it is empty or a message.
    */
    let returnCode: number | null = null;
    if (body.length >= 4) {
      const candidate = body.readUInt32BE(0);
      // Return codes are small. A payload beginning with four bytes that large is
      // ciphertext, not a code.
      if (candidate < 0x10000) {
        returnCode = candidate;
        body = body.subarray(4);
      }
    }

    frames.push({ sequence, command, returnCode, payload: body });
    offset += total;
  }

  return { frames, consumed: offset };
}

/** The 15-byte version marker 3.3 puts in front of an encrypted CONTROL payload. */
function versionHeader(version: TuyaVersion): Buffer {
  return Buffer.concat([Buffer.from(version, 'ascii'), Buffer.alloc(12)]);
}

export function buildQuery(deviceId: string, key: string, version: TuyaVersion, sequence = 1): Buffer {
  const now = Math.floor(Date.now() / 1000);
  const json = JSON.stringify({ gwId: deviceId, devId: deviceId, uid: deviceId, t: now });
  /*
    3.3 sends DP_QUERY encrypted with no version header, while CONTROL gets one. Sending
    the header on a query makes the device answer with a return code and no data — which
    looks exactly like a wrong key.
  */
  const payload = version === '3.3' ? encrypt(Buffer.from(json, 'utf8'), key) : Buffer.from(json, 'utf8');
  return encode(CMD.DP_QUERY, payload, sequence);
}

export function buildControl(
  deviceId: string,
  key: string,
  version: TuyaVersion,
  dps: Record<string, unknown>,
  sequence = 1,
): Buffer {
  const now = Math.floor(Date.now() / 1000);
  const json = JSON.stringify({ devId: deviceId, uid: deviceId, t: now, dps });
  if (version === '3.3') {
    const encrypted = encrypt(Buffer.from(json, 'utf8'), key);
    return encode(CMD.CONTROL, Buffer.concat([versionHeader('3.3'), encrypted]), sequence);
  }
  return encode(CMD.CONTROL, Buffer.from(json, 'utf8'), sequence);
}

/**
 * Turn a response payload into datapoints.
 *
 * Returns null rather than throwing on anything unreadable: a wrong key produces bytes
 * that decrypt to noise, and the caller wants "that key did not work", not a stack trace.
 */
export function parseResponse(payload: Buffer, key: string): Record<string, unknown> | null {
  if (payload.length === 0) return null;
  let body = payload;

  // A version marker may lead the payload on responses too; strip it before decrypting.
  const marker = body.subarray(0, 3).toString('ascii');
  if (isSupportedVersion(marker)) body = body.subarray(15);

  let text: string;
  try {
    text = decrypt(body, key).toString('utf8');
  } catch {
    // Not encrypted with this key — or not encrypted at all, which 3.1 allows.
    text = body.toString('utf8');
  }

  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start)) as { dps?: Record<string, unknown> };
    return parsed.dps ?? null;
  } catch {
    return null;
  }
}

/**
 * Which datapoint is the switch.
 *
 * Plugs and switches overwhelmingly use "1", but multi-gang and some meters start at "20".
 * Picking the first boolean rather than assuming "1" costs nothing and covers both.
 */
export function findSwitchDp(dps: Record<string, unknown>): string | null {
  for (const key of ['1', '20', ...Object.keys(dps)]) {
    if (typeof dps[key] === 'boolean') return key;
  }
  return null;
}
