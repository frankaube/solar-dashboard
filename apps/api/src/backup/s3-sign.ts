import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for talking to any S3-compatible store.
 *
 * Written by hand rather than pulled in as a dependency: this needs one PUT and one
 * GET, and the AWS SDK is tens of megabytes that would land in the Pi image and the
 * packaged binary for the sake of two requests.
 *
 * SigV4 is easy to get subtly wrong and the failure is opaque — the store returns
 * "SignatureDoesNotMatch" and tells you nothing about which of the six steps was off.
 * So this is checked against AWS's own published test vectors rather than against a
 * live bucket, which is the lesson the EcoFlow signer taught: that one passed its own
 * tests and failed the vendor's, because both were written from the same
 * misunderstanding.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SigV4Input {
  method: string;
  /** Path, already starting with a slash. Not yet URI-encoded. */
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  /** Raw body, or the literal 'UNSIGNED-PAYLOAD'. */
  body: Buffer | 'UNSIGNED-PAYLOAD';
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** ISO basic format, e.g. 20150830T123600Z. */
  amzDate: string;
}

const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * Percent-encode per RFC 3986, which is stricter than encodeURIComponent.
 *
 * `!'()*` are left alone by encodeURIComponent but must be encoded here, and getting
 * that wrong only shows up on object keys containing those characters — so it would
 * pass every test written with tidy filenames and fail on somebody's real bucket.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  return value
    .split('')
    .map((char) => {
      if (/[A-Za-z0-9\-._~]/.test(char)) return char;
      if (char === '/') return encodeSlash ? '%2F' : '/';
      return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

export function canonicalRequest(input: SigV4Input): { canonical: string; signedHeaders: string } {
  const payloadHash = input.body === 'UNSIGNED-PAYLOAD' ? 'UNSIGNED-PAYLOAD' : sha256(input.body);

  const canonicalQuery = Object.keys(input.query ?? {})
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(input.query![key])}`)
    .join('&');

  /*
    Header names lowercased, values whitespace-collapsed, sorted by name. The trailing
    newline after the last header is required and is a classic omission.
  */
  const entries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = entries.map(([n, v]) => `${n}:${v}\n`).join('');
  const signedHeaders = entries.map(([n]) => n).join(';');

  return {
    canonical: [
      input.method.toUpperCase(),
      uriEncode(input.path, false),
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n'),
    signedHeaders,
  };
}

/** The HMAC chain that turns a secret into a date/region/service-scoped key. */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export interface SignedRequest {
  authorization: string;
  signature: string;
  stringToSign: string;
}

export function signRequest(input: SigV4Input): SignedRequest {
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const { canonical, signedHeaders } = canonicalRequest(input);

  const stringToSign = [ALGORITHM, input.amzDate, scope, sha256(canonical)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(input.secretAccessKey, dateStamp, input.region, input.service),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
    stringToSign,
  };
}

/** ISO basic timestamp, the only format SigV4 accepts. */
export function amzDate(at: Date): string {
  return at.toISOString().replace(/[:-]|\.\d{3}/g, '');
}
