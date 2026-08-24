import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import {
  CMD,
  buildControl,
  buildQuery,
  decode,
  decrypt,
  encode,
  findSwitchDp,
  isPlausibleLocalKey,
  isSupportedVersion,
  parseResponse,
} from '../src/devices/tuya-protocol';

const KEY = '0123456789abcdef'; // 16 ASCII chars, as Tuya issues them
const DEVICE = 'bf1234567890abcdef';

describe('framing', () => {
  it('round-trips a frame', () => {
    const frame = encode(CMD.DP_QUERY, Buffer.from('hello'), 7);
    const { frames, consumed } = decode(frame);
    expect(consumed).toBe(frame.length);
    expect(frames).toHaveLength(1);
    expect(frames[0].sequence).toBe(7);
    expect(frames[0].command).toBe(CMD.DP_QUERY);
  });

  it('writes a length that counts the payload, the CRC and the suffix', () => {
    // Off-by-eight here produces a device that never answers and gives no error to read,
    // which is a genuinely miserable thing to debug.
    const payload = Buffer.from('abcdefgh');
    const frame = encode(CMD.CONTROL, payload);
    expect(frame.readUInt32BE(12)).toBe(payload.length + 8);
    expect(frame.length).toBe(16 + payload.length + 8);
  });

  it('writes a CRC over the header and payload', () => {
    const payload = Buffer.from('xyz');
    const frame = encode(CMD.CONTROL, payload);
    const expected = crc32(frame.subarray(0, frame.length - 8)) >>> 0;
    expect(frame.readUInt32BE(frame.length - 8)).toBe(expected);
  });

  it('reads two frames arriving in one read', () => {
    // A plug answers a query and pushes a status update in the same breath often enough
    // that assuming one frame per packet fails intermittently.
    const two = Buffer.concat([
      encode(CMD.DP_QUERY, Buffer.from('one'), 1),
      encode(CMD.CONTROL, Buffer.from('two'), 2),
    ]);
    const { frames, consumed } = decode(two);
    expect(frames.map((f) => f.sequence)).toEqual([1, 2]);
    expect(consumed).toBe(two.length);
  });

  it('leaves a partial frame in the buffer rather than mangling it', () => {
    const whole = encode(CMD.DP_QUERY, Buffer.from('partial'), 1);
    const { frames, consumed } = decode(whole.subarray(0, whole.length - 4));
    expect(frames).toEqual([]);
    expect(consumed).toBe(0);
  });

  it('resynchronises past leading rubbish', () => {
    const noisy = Buffer.concat([Buffer.from([0xff, 0x00, 0x12]), encode(CMD.DP_QUERY, Buffer.from('ok'), 3)]);
    const { frames } = decode(noisy);
    expect(frames).toHaveLength(1);
    expect(frames[0].sequence).toBe(3);
  });
});

describe('encryption', () => {
  it('encrypts a query payload for 3.3', () => {
    const frame = buildQuery(DEVICE, KEY, '3.3');
    const { frames } = decode(frame);
    const json = JSON.parse(decrypt(frames[0].payload, KEY).toString('utf8')) as { devId: string };
    expect(json.devId).toBe(DEVICE);
  });

  it('sends a query WITHOUT the version header', () => {
    /*
      3.3 puts a 15-byte version marker on CONTROL but not on DP_QUERY. Sending it on a
      query makes the device answer with a return code and no data — which looks exactly
      like a wrong key, and sends you hunting for the wrong problem.
    */
    const { frames } = decode(buildQuery(DEVICE, KEY, '3.3'));
    expect(frames[0].payload.subarray(0, 3).toString('ascii')).not.toBe('3.3');
  });

  it('sends control WITH the version header', () => {
    const { frames } = decode(buildControl(DEVICE, KEY, '3.3', { '1': true }));
    expect(frames[0].payload.subarray(0, 3).toString('ascii')).toBe('3.3');
    // 3 bytes of version + 12 of padding before the ciphertext.
    const body = frames[0].payload.subarray(15);
    const json = JSON.parse(decrypt(body, KEY).toString('utf8')) as { dps: Record<string, unknown> };
    expect(json.dps).toEqual({ '1': true });
  });

  it('leaves 3.1 payloads in the clear', () => {
    const { frames } = decode(buildQuery(DEVICE, KEY, '3.1'));
    expect(frames[0].payload.toString('utf8')).toContain(DEVICE);
  });
});

describe('parsing a response', () => {
  const respond = (dps: Record<string, unknown>, withHeader = false): Buffer => {
    const json = Buffer.from(JSON.stringify({ devId: DEVICE, dps }), 'utf8');
    const { createCipheriv } = require('node:crypto') as typeof import('node:crypto');
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(KEY, 'ascii'), null);
    const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);
    return withHeader
      ? Buffer.concat([Buffer.from('3.3', 'ascii'), Buffer.alloc(12), encrypted])
      : encrypted;
  };

  it('reads datapoints', () => {
    expect(parseResponse(respond({ '1': true, '9': 0 }), KEY)).toEqual({ '1': true, '9': 0 });
  });

  it('strips a version header when the device sends one', () => {
    expect(parseResponse(respond({ '1': false }, true), KEY)).toEqual({ '1': false });
  });

  it('returns null for a wrong key rather than throwing', () => {
    // A wrong key decrypts to noise. The caller wants "that key did not work", not a
    // stack trace out of the crypto layer.
    expect(parseResponse(respond({ '1': true }), 'ffffffffffffffff')).toBeNull();
  });

  it('returns null for an empty payload', () => {
    expect(parseResponse(Buffer.alloc(0), KEY)).toBeNull();
  });
});

describe('finding the switch datapoint', () => {
  it('prefers 1, which is what plugs use', () => {
    expect(findSwitchDp({ '1': true, '9': 0 })).toBe('1');
  });

  it('falls back to 20 for the devices that start there', () => {
    expect(findSwitchDp({ '20': false, '21': 'white' })).toBe('20');
  });

  it('takes any boolean rather than giving up', () => {
    expect(findSwitchDp({ '7': true })).toBe('7');
  });

  it('returns null when nothing is a switch', () => {
    expect(findSwitchDp({ '9': 0, '18': 230 })).toBeNull();
  });
});

describe('guard rails', () => {
  it('recognises a plausible local key', () => {
    expect(isPlausibleLocalKey(KEY)).toBe(true);
    // Checked up front because otherwise the failure is a decrypt error deep in a
    // response, which reads as "the device rejected us".
    expect(isPlausibleLocalKey('too short')).toBe(false);
    expect(isPlausibleLocalKey('0123456789abcdef0')).toBe(false);
    expect(isPlausibleLocalKey('')).toBe(false);
  });

  it('refuses 3.4 and 3.5 by name rather than half-supporting them', () => {
    expect(isSupportedVersion('3.3')).toBe(true);
    expect(isSupportedVersion('3.1')).toBe(true);
    expect(isSupportedVersion('3.4')).toBe(false);
    expect(isSupportedVersion('3.5')).toBe(false);
  });
});
