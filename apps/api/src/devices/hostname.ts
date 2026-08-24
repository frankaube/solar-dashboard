/**
 * What makes a usable `.local` name, and why a bad one has to be refused rather than tried.
 *
 * An invalid hostname does not fail loudly. The responder binds, answers nothing anyone
 * asked for, and the owner is left with a name that does not resolve and no indication of
 * why — which is indistinguishable, from the outside, from mDNS being broken on their
 * network. So the check happens before the name is ever stored.
 *
 * RFC 1123 label rules: letters, digits and hyphens; not starting or ending with a hyphen;
 * 63 octets at most. Case is not significant in DNS, and lowercasing rather than rejecting
 * a capital keeps "Solar" from being a validation error somebody has to think about.
 */

export const DEFAULT_HOSTNAME = 'solar-dashboard';
/** RFC 1035 caps a single label at 63 octets, and `.local` is appended after this. */
export const MAX_LABEL = 63;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type HostnameCheck =
  | { ok: true; hostname: string }
  | { ok: false; reason: string };

/**
 * Normalise and check one label.
 *
 * Takes a bare label, not a full name. A dot is the commonest mistake and gets its own
 * message: "solar.home.local" looks like a hostname and is a different thing entirely —
 * mDNS answers for single-label names under `.local` and would never be asked for that.
 */
export function checkHostname(raw: string): HostnameCheck {
  const hostname = raw.trim().toLowerCase();

  if (!hostname) return { ok: false, reason: 'Enter a name.' };
  if (hostname.endsWith('.local')) {
    return {
      ok: false,
      reason: 'Leave off the ".local" — it is added for you. Just the name, like "solar".',
    };
  }
  if (hostname.includes('.')) {
    return {
      ok: false,
      reason: 'One word, no dots. mDNS answers for a single name under .local, so "solar.home" would never be asked for.',
    };
  }
  if (hostname.length > MAX_LABEL) {
    return { ok: false, reason: `Too long — ${MAX_LABEL} characters at most.` };
  }
  if (hostname.startsWith('-') || hostname.endsWith('-')) {
    return { ok: false, reason: 'Cannot start or end with a hyphen.' };
  }
  if (!LABEL.test(hostname)) {
    return { ok: false, reason: 'Letters, digits and hyphens only.' };
  }
  return { ok: true, hostname };
}

/** The full name a browser would be pointed at. */
export function localName(hostname: string): string {
  return `${hostname}.local`;
}
