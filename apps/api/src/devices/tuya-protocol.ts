import { createCipheriv, createDecipheriv } from 'node:crypto';
import { crc32 } from 'node:zlib';

/**
 * Tuya's local protocol, enough of it to read a switch and flip one. Control frames are
 * encrypted with a key issued per device by Tuya's cloud, with no local way to obtain it —
 * hence "found, not readable" on the Devices page.
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
 * The version differences are in the payload, not the frame, and 3.3 is what most plugs
 * speak. 3.4 and 3.5 changed the handshake and are refused by name.
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
 * A local key is 16 ASCII characters, used directly as the AES-128 key. Checked before use,
 * or the failure is a decrypt error that reads as "the device rejected us".
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
 * Wrap a payload in the frame. The length field counts the payload plus CRC and suffix, not
 * the header; getting it wrong produces a device that never answers, with no error to read.
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
 * Pull frames out of a stream, returning every complete frame and the bytes consumed: a
 * single read can carry two frames or half of one, since a plug answers a query and pushes
 * a status update in the same breath.
 */
export function decode(buffer: Buffer): { frames: TuyaFrame[]; consumed: number } {
  const frames: TuyaFrame[] = [];
  let offset = 0;

  while (offset + 20 <= buffer.length) {
    if (buffer.readUInt32BE(offset) !== PREFIX) {
      // Resynchronise: a stray byte would otherwise poison the whole connection.
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
      Responses carry a 4-byte return code before the payload; requests do not. A non-zero
      code is an error, and the payload after it is empty or a message.
    */
    let returnCode: number | null = null;
    if (body.length >= 4) {
      const candidate = body.readUInt32BE(0);
      // Return codes are small; four bytes that large are ciphertext, not a code.
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
 * Turn a response payload into datapoints. Null rather than throwing: a wrong key decrypts
 * to noise, and the caller wants "that key did not work".
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
 * Which datapoint is the switch. Plugs mostly use "1", but multi-gang and some meters start
 * at "20", so this takes the first boolean rather than assuming.
 */
export function findSwitchDp(dps: Record<string, unknown>): string | null {
  for (const key of ['1', '20', ...Object.keys(dps)]) {
    if (typeof dps[key] === 'boolean') return key;
  }
  return null;
}
