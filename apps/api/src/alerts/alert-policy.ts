import { AlertSeverity } from './alert-rules';

/**
 * When an alert opens, and when it is worth telling someone.
 *
 * These are two different questions and the old system answered only one. Every
 * condition that held for a single poll opened an alert, and every alert that opened
 * or closed sent a push. Over one afternoon that produced eight open/close cycles on
 * four panels — sixteen notifications, one alert alive for exactly five minutes — all
 * reporting that a panel was somewhat below its neighbours on a partly cloudy day.
 *
 * Three ideas, in order:
 *
 *  1. CONFIRM. A condition must hold for several consecutive polls before it becomes
 *     an alert, and must be clear for several before it closes. Passing cloud shadow
 *     stops being an event.
 *  2. SEPARATE state from notification. Alerts open and close freely — that history is
 *     useful — but a push is a claim on someone's attention and is rationed.
 *  3. RATION by severity. An inverter being offline is worth an interruption. One
 *     panel down 18% is worth a line in a daily digest, and nothing more.
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
 * Tracks how long each condition has held or been absent.
 *
 * Streak COUNTS are deliberately in memory and not persisted: after a restart a
 * condition re-earns its confirmation, which errs toward silence. Reloading a stale
 * streak and firing on the first poll after a deploy is exactly the surprise
 * notification this exists to prevent.
 *
 * But which conditions are already OPEN must be restored — see `seed`. Without it the
 * close loop below, which iterates `streaks`, has nothing to iterate after a restart,
 * so an alert whose condition has since gone away can never be reported as over. Every
 * restart orphaned every open alert permanently: fifteen "inverter offline" rows from
 * one sunset were still demanding acknowledgement the next morning with the sun up and
 * the inverters back online.
 */
export class ConditionDebouncer {
  private streaks = new Map<ConditionKey, Streak>();

  constructor(
    private readonly confirmPolls: number = CONFIRM_POLLS,
    private readonly clearPolls: number = CLEAR_POLLS,
  ) {}

  /**
   * Restore conditions already open in storage, as confirmed and holding.
   *
   * Confirmed so they do not re-open and re-notify — they are already open. Holding so
   * that if the condition is genuinely still present nothing changes, and if it is
   * gone the normal clearing streak runs and closes it.
   */
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
        // Only report a close for something that actually opened; an unconfirmed
        // flicker should vanish without ever having existed.
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

/**
 * Route an opening alert.
 *
 * `serious` interrupts; `warning` waits for the digest. The cooldown then applies on
 * top, so a genuinely flapping serious condition — an inverter dropping in and out —
 * cannot push more than once per window however many times it cycles.
 */
export function routeOpen(ctx: NotifyContext, cooldownMs = RENOTIFY_COOLDOWN_MS): NotifyChannel {
  if (ctx.severity !== 'serious') return 'digest';
  if (ctx.lastNotifiedAt !== undefined && ctx.now - ctx.lastNotifiedAt < cooldownMs) {
    return 'suppress';
  }
  return 'immediate';
}

/**
 * Route a resolution.
 *
 * Only worth sending when the opening was itself worth interrupting for. "Resolved:
 * panel at 105 W" is not news, and sending it doubled the old system's volume for no
 * information — the resolution of something you were never told about is noise by
 * construction.
 */
export function routeClose(notifiedOpen: boolean): NotifyChannel {
  return notifiedOpen ? 'immediate' : 'suppress';
}

export interface DigestEntry {
  severity: AlertSeverity;
  message: string;
}

/**
 * Fold held-back warnings into one message.
 *
 * Grouped by identical message so a panel that opened, closed and reopened three
 * times appears once with a count, rather than as three separate lines that read like
 * three separate problems.
 */
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
 * One notification per condition, not one per affected device.
 *
 * A fleet fails together far more often than it fails individually: the sun sets, a
 * DTU reboots, a breaker trips. When it does, the old path sent a separate message
 * for every inverter — twelve texts in one minute, all saying the same thing, which
 * trains someone to ignore the next one. The alert ROWS stay per-inverter so the UI
 * can still show exactly which units are affected; only the interruption is folded.
 *
 * A single alert keeps its original wording. There is no value in rephrasing one
 * offline inverter as "1 inverter is offline".
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
    // Worst severity in the group decides how loudly the whole thing is announced.
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
 * Pull the identifying noun out of a message so the combined line stays readable.
 *
 * The per-alert messages are written to stand alone ("Inverter 4A2F is offline"), so
 * concatenating them whole would produce a paragraph that repeats the verb once per
 * device. Falls back to the whole message when there is no recognisable subject,
 * which is worse-looking but never wrong.
 */
function subjectName(message: string): string {
  const match = /^(?:Inverter|Panel|Port)\s+(\S+)/i.exec(message);
  return match ? match[1] : message;
}
