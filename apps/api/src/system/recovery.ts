/**
 * The watchdog bounces links, reloads drivers and reboots; each is a success, so a Pi
 * doing them nightly looks identical to one that never needed to. This reads its log.
 */

export type RecoveryAction = 'link-bounce' | 'driver-reload' | 'reboot' | 'recovered';

export interface RecoveryEvent {
  at: string;
  action: RecoveryAction | string;
  detail: string;
}

/** Where netwatch.sh writes. Overridable so a non-standard install can point elsewhere. */
export const RECOVERY_LOG = process.env.RECOVERY_LOG ?? '/var/lib/solar-dashboard/recovery.jsonl';

/** Recent enough to be about now rather than about the machine's whole history. */
export const RECENT_DAYS = 14;

/**
 * Line-delimited JSON written by a shell script: a torn final line from a machine that
 * lost power mid-write is expected, and must not cost the rest of the history.
 */
export function parseRecoveryLog(text: string): RecoveryEvent[] {
  const events: RecoveryEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<RecoveryEvent>;
      if (typeof parsed.at !== 'string' || typeof parsed.action !== 'string') continue;
      if (Number.isNaN(Date.parse(parsed.at))) continue;
      events.push({ at: parsed.at, action: parsed.action, detail: parsed.detail ?? '' });
    } catch {
      // A half-written line is exactly what a power cut leaves behind. Skip it.
    }
  }
  return events;
}

export interface RecoverySummary {
  events: RecoveryEvent[];
  /** Repairs only — a `recovered` line is the outcome, not an action taken. */
  repairs: number;
  reboots: number;
  since: string | null;
  /** Said in words, because a count on its own does not tell you whether to worry. */
  verdict: string | null;
}

const REPAIRS = new Set(['link-bounce', 'driver-reload', 'reboot']);

/**
 * Newest first, with a verdict. Thresholds are deliberately low: one link bounce in a
 * fortnight is a bad evening, a reboot a week is hardware on its way out.
 */
export function summariseRecovery(
  events: RecoveryEvent[],
  now = Date.now(),
  days = RECENT_DAYS,
): RecoverySummary {
  const cutoff = now - days * 86_400_000;
  const recent = events
    .filter((event) => Date.parse(event.at) >= cutoff)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const repairs = recent.filter((event) => REPAIRS.has(event.action)).length;
  const reboots = recent.filter((event) => event.action === 'reboot').length;
  const oldest = recent.length ? recent[recent.length - 1].at : null;

  let verdict: string | null = null;
  if (reboots >= 2) {
    verdict = `Restarted itself ${reboots} times in ${days} days. That is not a network having a bad week — check the power supply and the drive.`;
  } else if (reboots === 1) {
    verdict = `Restarted itself once in ${days} days because the network did not come back any other way.`;
  } else if (repairs >= 5) {
    verdict = `Repaired the network ${repairs} times in ${days} days. It is staying up, but something upstream is unhappy.`;
  } else if (repairs > 0) {
    verdict = `Repaired the network ${repairs === 1 ? 'once' : `${repairs} times`} in the last ${days} days.`;
  }

  return { events: recent, repairs, reboots, since: oldest, verdict };
}
