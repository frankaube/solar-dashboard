import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseTuyaBroadcast } from '../src/devices/tuya-discovery';

const UDP_KEY = createHash('md5').update('yGAdlopoPVldABfn').digest();

/** Build an encrypted 6667-style frame the way a device does. */
function encryptedFrame(payload: object, headerBytes = 20): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const padLen = 16 - (json.length % 16);
  const padded = Buffer.concat([json, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv('aes-128-ecb', UDP_KEY, null);
  cipher.setAutoPadding(false);
  const body = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([Buffer.alloc(headerBytes), body, Buffer.alloc(8)]);
}

function plainFrame(payload: object): Buffer {
  return Buffer.concat([
    Buffer.from('000055aa', 'hex'),
    Buffer.alloc(12),
    Buffer.from(JSON.stringify(payload), 'utf8'),
    Buffer.from('0000aa55', 'hex'),
  ]);
}

/**
 * These frames are the only thing standing between "we support Tuya" and "the scan
 * silently reports nothing" — a parse failure here looks identical to an empty
 * network, which is exactly the class of quiet wrongness this project keeps hitting.
 */
describe('parseTuyaBroadcast', () => {
  // Shape taken from a real announcement observed on the LAN, with the id changed.
  const REAL = {
    ip: '10.0.0.115',
    gwId: '67208617500291020b19',
    active: 2,
    ability: 0,
    mode: 0,
    encrypt: true,
    productKey: 'keyvtdmgqcsh5hug',
    version: '3.3',
  };

  it('decrypts a 3.3 announcement', () => {
    const parsed = parseTuyaBroadcast(encryptedFrame(REAL));
    expect(parsed).toMatchObject({ gwId: REAL.gwId, version: '3.3', encrypt: true });
  });

  it('handles the shorter header framing too', () => {
    // Firmware varies on whether a return code precedes the payload; both must work
    // rather than one silently yielding nothing.
    expect(parseTuyaBroadcast(encryptedFrame(REAL, 16))?.gwId).toBe(REAL.gwId);
  });

  it('reads an unencrypted 3.1 announcement', () => {
    const parsed = parseTuyaBroadcast(plainFrame({ gwId: 'abc123', ip: '10.0.0.9', version: '3.1' }));
    expect(parsed).toMatchObject({ gwId: 'abc123', version: '3.1' });
  });

  it('returns null for a foreign packet rather than throwing', () => {
    // Both ports are shared with whatever else broadcasts on the LAN. One malformed
    // packet must not take down the sweep.
    expect(parseTuyaBroadcast(Buffer.from('not tuya at all'))).toBeNull();
    expect(parseTuyaBroadcast(Buffer.alloc(0))).toBeNull();
    expect(parseTuyaBroadcast(Buffer.from('deadbeef'.repeat(16), 'hex'))).toBeNull();
  });

  it('rejects valid JSON that is not a device announcement', () => {
    // Without a gwId there is nothing to identify or adopt, so it is not a device.
    expect(parseTuyaBroadcast(plainFrame({ hello: 'world' }))).toBeNull();
  });

  it('does not mistake a truncated frame for a device', () => {
    const short = encryptedFrame(REAL).subarray(0, 24);
    expect(parseTuyaBroadcast(short)).toBeNull();
  });
});
