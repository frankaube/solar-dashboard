import { AlertSeverity } from './alert-rules';

/**
 * Opening an alert and pushing it are separate decisions. A condition must hold several
 * polls to open and be clear for several to close; pushes are then rationed by severity.
 */

/** Consecutive evaluations a condition must hold before an alert opens. */
export const CONFIRM_POLLS = 3;
/** Consecutive evaluations it must be absent before the alert closes. */
export const CLEAR_POLLS = 3;
/** Minimum gap before the same subject may push again, even if it re-opens. */
export const RENOTIFY_COOLDOWN_MS = 6 * 60 * 60_000;

export type ConditionKey = string;

interface Streak {
  /** Consecutive polls the condition has held. */
  holding: number;
  /** Consecutive polls it has been absent. */
  clearing: number;
  confirmed: boolean;
}

export interface DebounceResult {
  /** Conditions newly confirmed this poll — these become alerts. */
  toOpen: ConditionKey[];
  /** Conditions absent long enough to be considered over. */
  toClose: ConditionKey[];
}

/**
 * Streak COUNTS are in memory, so a condition re-earns confirmation after a restart. Open
 * conditions must be restored — see `seed`; the close loop iterates `streaks`.
 */
export class ConditionDebouncer {
  private streaks = new Map<ConditionKey, Streak>();

  constructor(
    private readonly confirmPolls: number = CONFIRM_POLLS,
    private readonly clearPolls: number = CLEAR_POLLS,
  ) {}

  /** Confirmed so they do not re-notify; holding so a departed condition still clears. */
  seed(keys: Iterable<ConditionKey>): void {
    for (const key of keys) {
      if (!this.streaks.has(key)) {
        this.streaks.set(key, { holding: this.confirmPolls, clearing: 0, confirmed: true });
      }
    }
  }

  /** Feed one evaluation's active conditions; get what should change. */
  step(active: ReadonlySet<ConditionKey>): DebounceResult {
    const toOpen: ConditionKey[] = [];
    const toClose: ConditionKey[] = [];

    for (const key of active) {
      const streak = this.streaks.get(key) ?? { holding: 0, clearing: 0, confirmed: false };
      streak.holding += 1;
      streak.clearing = 0;
      if (!streak.confirmed && streak.holding >= this.confirmPolls) {
        streak.confirmed = true;
        toOpen.push(key);
      }
      this.streaks.set(key, streak);
    }

    for (const [key, streak] of this.streaks) {
      if (active.has(key)) continue;
      streak.clearing += 1;
      streak.holding = 0;
      if (streak.clearing >= this.clearPolls) {
        // Only close what actually opened; an unconfirmed flicker never existed.
        if (streak.confirmed) toClose.push(key);
        this.streaks.delete(key);
      }
    }

    return { toOpen, toClose };
  }

  /** Test/diagnostic view of a condition's current streak. */
  peek(key: ConditionKey): Readonly<Streak> | undefined {
    return this.streaks.get(key);
  }
}

export type NotifyChannel =
  /** Push now — worth interrupting someone for. */
  | 'immediate'
  /** Hold for the next digest. */
  | 'digest'
  /** Say nothing at all. */
  | 'suppress';

export interface NotifyContext {
  severity: AlertSeverity;
  subjectKey: ConditionKey;
  /** When this subject last produced an immediate push, if ever. */
  lastNotifiedAt?: number;
  now: number;
}

/** `serious` interrupts, `warning` digests; the cooldown then caps pushes per window. */
export function routeOpen(ctx: NotifyContext, cooldownMs = RENOTIFY_COOLDOWN_MS): NotifyChannel {
  if (ctx.severity !== 'serious') return 'digest';
  if (ctx.lastNotifiedAt !== undefined && ctx.now - ctx.lastNotifiedAt < cooldownMs) {
    return 'suppress';
  }
  return 'immediate';
}

/** Only worth sending when the opening was itself worth interrupting for. */
export function routeClose(notifiedOpen: boolean): NotifyChannel {
  return notifiedOpen ? 'immediate' : 'suppress';
}

export interface DigestEntry {
  severity: AlertSeverity;
  message: string;
}

/** Fold held-back warnings into one message, grouped by identical message with a count. */
export function buildDigest(entries: DigestEntry[]): string | null {
  if (entries.length === 0) return null;
  const counts = new Map<string, { entry: DigestEntry; count: number }>();
  for (const entry of entries) {
    const existing = counts.get(entry.message);
    if (existing) existing.count += 1;
    else counts.set(entry.message, { entry, count: 1 });
  }
  const lines = [...counts.values()]
    .sort((a, b) => (a.entry.severity === b.entry.severity ? b.count - a.count : a.entry.severity === 'serious' ? -1 : 1))
    .map(({ entry, count }) => `• ${entry.message}${count > 1 ? ` (${count}×)` : ''}`);
  const subjects = counts.size;
  return `${subjects} thing${subjects === 1 ? '' : 's'} worth a look:\n${lines.join('\n')}`;
}

export interface CoalesceInput {
  type: string;
  severity: AlertSeverity;
  subjectKey: string;
  message: string;
}

export interface CoalescedNotification {
  severity: AlertSeverity;
  message: string;
  /** How many alerts this one message stands for. */
  count: number;
  keys: string[];
}

/** Names listed in full before we switch to "and N more". */
const MAX_NAMED_SUBJECTS = 4;

/**
 * One notification per condition, not per device — a fleet fails together (sunset, DTU
 * reboot, tripped breaker). Alert ROWS stay per-inverter; only the interruption folds.
 */
export function coalesceNotifications(alerts: CoalesceInput[]): CoalescedNotification[] {
  const groups = new Map<string, CoalesceInput[]>();
  for (const alert of alerts) {
    const list = groups.get(alert.type) ?? [];
    list.push(alert);
    groups.set(alert.type, list);
  }

  const out: CoalescedNotification[] = [];
  for (const [type, group] of groups) {
    if (group.length === 1) {
      out.push({
        severity: group[0].severity,
        message: group[0].message,
        count: 1,
        keys: [group[0].subjectKey],
      });
      continue;
    }
    // Worst severity in the group wins.
    const severity: AlertSeverity = group.some((a) => a.severity === 'serious')
      ? 'serious'
      : 'warning';
    const named = group.slice(0, MAX_NAMED_SUBJECTS).map((a) => subjectName(a.message));
    const rest = group.length - named.length;
    const subjects = rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
    out.push({
      severity,
      message: `${group.length} ${headline(type, group.length)}: ${subjects}`,
      count: group.length,
      keys: group.map((a) => a.subjectKey),
    });
  }
  return out;
}

function headline(type: string, count: number): string {
  const plural = count === 1 ? '' : 's';
  switch (type) {
    case 'inverter_offline':
      return `inverter${plural} offline`;
    case 'inverter_silent':
      return `inverter${plural} reporting no data`;
    case 'port_underperforming':
      return `panel${plural} underperforming`;
    case 'source_silent':
      return `data source${plural} not reporting`;
    default:
      return `alert${plural}`;
  }
}

/**
 * Messages stand alone ("Inverter 4A2F is offline"), so concatenating them whole repeats
 * the verb per device. Falls back to the whole message when there is no subject.
 */
function subjectName(message: string): string {
  const match = /^(?:Inverter|Panel|Port)\s+(\S+)/i.exec(message);
  return match ? match[1] : message;
}
