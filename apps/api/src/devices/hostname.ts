/**
 * What makes a usable `.local` name. An invalid one does not fail loudly: the responder
 * binds, answers nothing anyone asked for, and the name never resolves — indistinguishable
 * from mDNS being broken. So it is checked before being stored.
 *
 * RFC 1123 label rules: letters, digits and hyphens; not starting or ending with a hyphen;
 * 63 octets at most. DNS is case-insensitive, so a capital is lowercased, not rejected.
 */

export const DEFAULT_HOSTNAME = 'solar-dashboard';
/** RFC 1035 caps a single label at 63 octets, and `.local` is appended after this. */
export const MAX_LABEL = 63;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type HostnameCheck =
  | { ok: true; hostname: string }
  | { ok: false; reason: string };

/**
 * Normalise and check one label — a bare label, not a full name. A dot is the commonest
 * mistake and gets its own message: mDNS answers for single-label names under `.local`.
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
