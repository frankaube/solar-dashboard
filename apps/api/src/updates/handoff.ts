import { Channel, DEFAULT_CHANNEL, isChannel } from './releases';

/**
 * The three files the app and the privileged updater use to talk to each other.
 *
 * They exist because the thing that downloads and executes a new binary as root must not
 * be the internet-facing web app. The app runs unprivileged, cannot write /opt and cannot
 * call systemctl; a root-owned systemd timer does the install. So the two halves need a
 * channel, and a file in the data directory is the whole of it — no socket to secure, no
 * privileged helper to audit, and it survives the update that replaces the install.
 *
 * The direction of each file is the security boundary, so it is stated per type:
 *
 *   update-policy.json    app  -> updater   what the user chose
 *   update-request.json   app  -> updater   "yes, install it"
 *   update-state.json     updater -> app    what happened
 *
 * THE REQUEST CARRIES A VERSION AND NOTHING ELSE. No URL, no asset name, no feed. The
 * updater resolves the feed from its own root-owned config and refuses unless what it
 * independently finds matches the version asked for. That way a compromised app can at
 * worst ask for a real, signed release it was already going to be offered — it cannot
 * choose what root downloads, which is the only thing that would actually matter.
 */

export const POLICY_FILE = 'update-policy.json';
export const REQUEST_FILE = 'update-request.json';
export const STATE_FILE = 'update-state.json';

export interface UpdatePolicy {
  channel: Channel;
  /** False means notify only: check and show, never install by itself. */
  apply: boolean;
  /** Local hour the unattended install may start. */
  hour: number;
}

/**
 * Notify-only, off, at 3 AM.
 *
 * Silently replacing the binary on someone's electrical monitoring is opted into, not
 * defaulted into — and `off` means no outbound request at all, which is the only version
 * of "no telemetry" worth claiming.
 */
export const DEFAULT_POLICY: UpdatePolicy = { channel: DEFAULT_CHANNEL, apply: false, hour: 3 };

export const MIN_HOUR = 0;
export const MAX_HOUR = 23;

/** Absent is checked before the range: Number(null) is 0, which would look like midnight. */
export function normaliseHour(value: unknown, fallback = DEFAULT_POLICY.hour): number {
  if (value === null || value === undefined || value === '') return fallback;
  const hour = Math.trunc(Number(value));
  return Number.isFinite(hour) && hour >= MIN_HOUR && hour <= MAX_HOUR ? hour : fallback;
}

function object(body: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * Read a policy file, falling back field by field.
 *
 * Never throws and never returns null: a corrupt or truncated policy has to mean "the
 * safe default" rather than "crash the updater", because the updater runs at 3 AM with
 * nobody watching and a crash there is indistinguishable from working.
 */
export function parsePolicy(body: string | null | undefined): UpdatePolicy {
  const raw = typeof body === 'string' ? object(body) : null;
  if (!raw) return { ...DEFAULT_POLICY };
  return {
    channel: isChannel(raw.channel) ? raw.channel : DEFAULT_POLICY.channel,
    apply: raw.apply === true,
    hour: normaliseHour(raw.hour),
  };
}

export function serialisePolicy(policy: UpdatePolicy): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

export interface UpdateRequest {
  version: string;
  requestedAt: string;
}

export function parseRequest(body: string | null | undefined): UpdateRequest | null {
  const raw = typeof body === 'string' ? object(body) : null;
  if (!raw) return null;
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  // A version is the entire payload, so an empty one is not a request — it is a file to
  // delete. Accepting it would mean "install whatever you find", which is the one thing
  // this format exists to prevent.
  if (!version) return null;
  const requestedAt = typeof raw.requestedAt === 'string' ? raw.requestedAt : '';
  return { version, requestedAt };
}

export function serialiseRequest(request: UpdateRequest): string {
  return `${JSON.stringify(request, null, 2)}\n`;
}

export type UpdateResult = 'ok' | 'rolled-back' | 'failed' | 'refused';

export interface UpdateState {
  startedAt: string | null;
  finishedAt: string | null;
  fromVersion: string | null;
  fromCommit: string | null;
  toVersion: string | null;
  result: UpdateResult | null;
  message: string | null;
  /** Last time the updater looked, whether or not it found anything. */
  checkedAt: string | null;
}

const RESULTS: UpdateResult[] = ['ok', 'rolled-back', 'failed', 'refused'];

export function parseState(body: string | null | undefined): UpdateState | null {
  const raw = typeof body === 'string' ? object(body) : null;
  if (!raw) return null;
  const text = (key: string): string | null =>
    typeof raw[key] === 'string' && (raw[key] as string).length > 0 ? (raw[key] as string) : null;
  const result = RESULTS.find((known) => known === raw.result) ?? null;
  return {
    startedAt: text('startedAt'),
    finishedAt: text('finishedAt'),
    fromVersion: text('fromVersion'),
    fromCommit: text('fromCommit'),
    toVersion: text('toVersion'),
    result,
    message: text('message'),
    checkedAt: text('checkedAt'),
  };
}

/** How the last attempt reads in a sentence. Null when nothing has ever run. */
export function describeState(state: UpdateState | null): string | null {
  if (!state || !state.result) return null;
  const when = state.finishedAt ?? state.startedAt;
  const at = when ? new Date(when) : null;
  const stamp = at && !Number.isNaN(at.getTime()) ? at.toISOString().replace('T', ' ').slice(0, 16) : null;
  const from = state.fromVersion ?? 'an unknown version';
  const to = state.toVersion ?? 'an unknown version';
  const tail = stamp ? ` (${stamp} UTC)` : '';
  switch (state.result) {
    case 'ok':
      return `Installed ${to}, replacing ${from}${tail}.`;
    case 'rolled-back':
      return `${to} did not come up. Rolled back to ${from}${tail}. ${state.message ?? ''}`.trim();
    case 'failed':
      return `Update to ${to} failed and was not installed${tail}. ${state.message ?? ''}`.trim();
    case 'refused':
      return `Update to ${to} was refused${tail}. ${state.message ?? ''}`.trim();
  }
}
