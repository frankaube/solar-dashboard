import { describe, expect, it } from 'vitest';
import {
  amzDate,
  canonicalRequest,
  signRequest,
  signingKey,
  uriEncode,
} from '../src/backup/s3-sign';

/**
 * AWS's own published vectors, not vectors I invented.
 *
 * This is the EcoFlow lesson applied before the fact: that signer passed a full suite
 * of tests and still failed the vendor's published vector, because the tests and the
 * implementation were written from the same misunderstanding. A signature is exactly
 * the kind of code that cannot validate itself — the store just says
 * "SignatureDoesNotMatch" and names none of the six steps.
 */

const AWS_EXAMPLE = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  amzDate: '20150830T123600Z',
};

describe('signing key derivation', () => {
  it('matches the key from the AWS documentation example', () => {
    /*
      From "Examples of how to derive a signing key for Signature Version 4" —
      secret wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, 20120215, us-east-1, iam.
    */
    const key = signingKey(
      'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      '20120215',
      'us-east-1',
      'iam',
    );
    expect(key.toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });
});

describe('get-vanilla, from the AWS SigV4 test suite', () => {
  const input = {
    method: 'GET',
    path: '/',
    headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
    body: Buffer.alloc(0),
    ...AWS_EXAMPLE,
  };

  it('builds the canonical request AWS specifies', () => {
    const { canonical, signedHeaders } = canonicalRequest(input);
    expect(signedHeaders).toBe('host;x-amz-date');
    expect(canonical).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
  });

  it('produces the published signature', () => {
    expect(signRequest(input).signature).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('formats the Authorization header the way S3 parses it', () => {
    const auth = signRequest(input).authorization;
    expect(auth).toContain('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request');
    expect(auth).toContain('SignedHeaders=host;x-amz-date');
    expect(auth).toContain('Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });
});

/**
 * The encoding rules, which are where a hand-written signer usually breaks — and
 * breaks only for some object names, so tidy test filenames hide it.
 */
describe('uriEncode', () => {
  it('leaves the unreserved set alone', () => {
    expect(uriEncode('abcXYZ019-._~')).toBe('abcXYZ019-._~');
  });

  it('encodes the characters encodeURIComponent wrongly permits', () => {
    // These are the ones that make a naive implementation pass locally and fail live.
    expect(uriEncode("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('encodes spaces as %20, never as +', () => {
    expect(uriEncode('a b')).toBe('a%20b');
  });

  it('keeps slashes in a path but encodes them in a value', () => {
    expect(uriEncode('/solar/backup.db', false)).toBe('/solar/backup.db');
    expect(uriEncode('/solar/backup.db')).toBe('%2Fsolar%2Fbackup.db');
  });
});

describe('canonical request assembly', () => {
  it('sorts headers by lowercased name', () => {
    const { signedHeaders } = canonicalRequest({
      method: 'PUT',
      path: '/x',
      headers: { 'X-Amz-Date': 'd', Host: 'h', 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(0),
      ...AWS_EXAMPLE,
    });
    expect(signedHeaders).toBe('content-type;host;x-amz-date');
  });

  it('collapses runs of whitespace inside header values', () => {
    const { canonical } = canonicalRequest({
      method: 'GET',
      path: '/',
      headers: { Host: '  example.com  ', 'X-Amz-Date': 'd' },
      body: Buffer.alloc(0),
      ...AWS_EXAMPLE,
    });
    expect(canonical).toContain('host:example.com\n');
  });

  it('sorts and encodes the query string', () => {
    const { canonical } = canonicalRequest({
      method: 'GET',
      path: '/',
      query: { b: '2', a: '1 space' },
      headers: { Host: 'h' },
      body: Buffer.alloc(0),
      ...AWS_EXAMPLE,
    });
    expect(canonical.split('\n')[2]).toBe('a=1%20space&b=2');
  });

  it('hashes the body, and honours UNSIGNED-PAYLOAD verbatim', () => {
    const withBody = canonicalRequest({
      method: 'PUT',
      path: '/x',
      headers: { Host: 'h' },
      body: Buffer.from('hello'),
      ...AWS_EXAMPLE,
    });
    expect(withBody.canonical.split('\n').pop()).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    const unsigned = canonicalRequest({
      method: 'PUT',
      path: '/x',
      headers: { Host: 'h' },
      body: 'UNSIGNED-PAYLOAD',
      ...AWS_EXAMPLE,
    });
    expect(unsigned.canonical.split('\n').pop()).toBe('UNSIGNED-PAYLOAD');
  });
});

describe('amzDate', () => {
  it('emits ISO basic format, which is the only one SigV4 accepts', () => {
    expect(amzDate(new Date('2015-08-30T12:36:00.000Z'))).toBe('20150830T123600Z');
  });

  it('drops milliseconds rather than rounding them into the timestamp', () => {
    expect(amzDate(new Date('2026-07-29T11:22:33.456Z'))).toBe('20260729T112233Z');
  });
});
