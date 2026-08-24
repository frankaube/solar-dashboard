import { createHmac } from 'node:crypto';

/**
 * EcoFlow Open API request signing.
 *
 * Extracted from the client so it can be tested against EcoFlow's own published
 * self-test vector, which is the only way to know this is right without credentials.
 * A signing bug is not subtly wrong — every request fails — and it would only surface
 * the moment real hardware appeared.
 *
 * Two details the prose description makes easy to get wrong, both of which the
 * previous implementation did get wrong:
 *
 * 1. The `accessKey`/`nonce`/`timestamp` triple is APPENDED after the sorted business
 *    params, not sorted together with them. Sorting them in puts `accessKey` first,
 *    which is correct only when there are no params at all — so the device-list call
 *    passed by coincidence while every state read would have failed.
 * 2. Nested structures are flattened before sorting: `params.cmdSet=11`,
 *    `deviceList[0].id=1`, `ids[0]=1`. Sorting happens on the FLATTENED keys, which is
 *    why `params.cmdSet` precedes `sn`.
 */

export interface EcoFlowAuth {
  accessKey: string;
  nonce: string;
  timestamp: string;
}

type Primitive = string | number | boolean;

/**
 * Flatten a request body into the dotted/bracketed keys EcoFlow signs over.
 * Undefined and null are dropped: signing the literal text "undefined" produces a
 * valid-looking signature for a request the server will reject, which is a
 * frustrating thing to debug.
 */
export function flattenParams(input: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (input === undefined || input === null) return out;

  if (Array.isArray(input)) {
    input.forEach((item, i) => Object.assign(out, flattenParams(item, `${prefix}[${i}]`)));
    return out;
  }
  if (typeof input === 'object') {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      Object.assign(out, flattenParams(value, prefix ? `${prefix}.${key}` : key));
    }
    return out;
  }
  if (prefix) out[prefix] = String(input as Primitive);
  return out;
}

/** The exact string EcoFlow expects the HMAC to be computed over. */
export function ecoflowCanonical(params: unknown, auth: EcoFlowAuth): string {
  const flat = flattenParams(params);
  const sorted = Object.keys(flat)
    .sort()
    .map((k) => `${k}=${flat[k]}`);
  // Appended, deliberately not merged into the sort above.
  sorted.push(
    `accessKey=${auth.accessKey}`,
    `nonce=${auth.nonce}`,
    `timestamp=${auth.timestamp}`,
  );
  return sorted.join('&');
}

export function ecoflowSign(
  params: unknown,
  auth: EcoFlowAuth & { secretKey: string },
): string {
  return createHmac('sha256', auth.secretKey)
    .update(ecoflowCanonical(params, auth))
    .digest('hex');
}
