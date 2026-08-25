import { createHmac } from 'node:crypto';

/**
 * EcoFlow Open API request signing, checked against EcoFlow's published test vector.
 * The `accessKey`/`nonce`/`timestamp` triple is APPENDED after the sorted business
 * params, not sorted with them. Nested structures flatten first (`params.cmdSet=11`,
 * `deviceList[0].id=1`, `ids[0]=1`) and the sort is on the FLATTENED keys, so
 * `params.cmdSet` precedes `sn`.
 */

export interface EcoFlowAuth {
  accessKey: string;
  nonce: string;
  timestamp: string;
}

type Primitive = string | number | boolean;

/** Flatten into the dotted/bracketed keys EcoFlow signs. Null and undefined are dropped, not stringified. */
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
