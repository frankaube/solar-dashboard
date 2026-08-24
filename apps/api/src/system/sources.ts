/**
 * Whether the dashboard is actually being told anything.
 *
 * The Health page answers "is anything wrong with the array". This answers a different
 * question, and they can disagree for a long time: a source that stops reporting does not
 * look like a problem, it looks like a quiet day. On this install the charger sat frozen for
 * eighteen hours and the vehicle logger was down overnight while every figure on the Overview
 * looked healthy, because the last good reading stays on screen forever.
 */

export type SourceState = 'live' | 'partial' | 'late' | 'silent' | 'never' | 'off';

/** One poll window: it answered, it should have and did not, or nothing was expected. */
export type Attempt = 'ok' | 'miss' | 'none';

/**
 * How late is late.
 *
 * Two intervals rather than one, because a single missed poll is normal and a run of them is
 * not. The floors matter more than the multiples: a charger polled every thirty seconds would
 * otherwise be called silent after six minutes, which is a car asleep rather than a fault.
 */
const LATE_AFTER = 2;
const LATE_FLOOR_MS = 90_000;
const SILENT_AFTER = 10;
const SILENT_FLOOR_MS = 20 * 60_000;

export interface SourceTiming {
  /** False when nothing is expected at all: no battery, no charger configured. */
  configured: boolean;
  lastSeenAt: Date | null;
  /** How often this source should answer. Null for the ones a person feeds by hand. */
  cadenceMs: number | null;
  /**
   * Answering on time, but not with everything it should carry.
   *
   * The gateway is the case this exists for: it replies every five minutes without fail
   * while one inverter's detail and four panels are missing from what it replies WITH. That
   * is not lateness, and calling it late would send someone to look at the network.
   */
  incomplete?: boolean;
}

export function stateOf(timing: SourceTiming, now: Date = new Date()): SourceState {
  if (!timing.configured) return 'off';
  /*
    Never is its own answer and not a very old "silent".

    A source adopted months ago that has never once returned a reading is a different fault
    from one that answered this morning and stopped: the first was never working, and no
    amount of waiting will fix it. Four devices on this install are in exactly that state and
    the app has had no way to say so.
  */
  if (timing.lastSeenAt === null) return 'never';
  if (timing.cadenceMs === null) return timing.incomplete ? 'partial' : 'live';

  const age = now.getTime() - timing.lastSeenAt.getTime();
  const silentAfter = Math.max(timing.cadenceMs * SILENT_AFTER, SILENT_FLOOR_MS);
  const lateAfter = Math.max(timing.cadenceMs * LATE_AFTER, LATE_FLOOR_MS);
  // Silence outranks incompleteness: a source that has stopped is the worse news.
  if (age > silentAfter) return 'silent';
  if (age > lateAfter) return 'late';
  return timing.incomplete ? 'partial' : 'live';
}

/**
 * The last few poll windows, oldest first.
 *
 * Derived from the readings each poller already stores rather than from a log of attempts
 * written for this page. That keeps it free — no new rows, no new write path on a machine
 * that is already writing every five minutes — and it measures the thing worth measuring,
 * which is whether a reading actually landed rather than whether some code claimed to try.
 *
 * Worth being plain about the one thing it cannot see: a poll that succeeded and stored
 * nothing is indistinguishable from one that never ran. Both are a gap, and a gap is what
 * the strip is for.
 */
export function attemptsFrom(
  readingTimes: Date[],
  cadenceMs: number,
  buckets = 12,
  now: Date = new Date(),
): Attempt[] {
  if (cadenceMs <= 0) return Array.from({ length: buckets }, () => 'none' as Attempt);
  const end = now.getTime();
  const stamps = readingTimes.map((at) => at.getTime()).sort((a, b) => a - b);
  const out: Attempt[] = [];
  for (let i = buckets - 1; i >= 0; i--) {
    const from = end - (i + 1) * cadenceMs;
    const to = end - i * cadenceMs;
    /*
      Inclusive of the window's end so a reading landing exactly on a boundary counts once,
      for the newer window. Off by one here would show a permanent miss on a source that is
      answering perfectly.
    */
    out.push(stamps.some((at) => at > from && at <= to) ? 'ok' : 'miss');
  }
  return out;
}

/** What a source with nothing expected of it shows: an empty strip, not a row of failures. */
export function noAttempts(buckets = 12): Attempt[] {
  return Array.from({ length: buckets }, () => 'none');
}

export interface SourceRow {
  id: string;
  name: string;
  /** Where it lives, or what it is. Shown small under the name. */
  detail: string;
  state: SourceState;
  lastSeenAt: string | null;
  cadenceMs: number | null;
  /** "5 min", "with the gateway", "you import it". */
  cadenceText: string;
  attempts: Attempt[];
  /** Said in full where the state alone would mislead. */
  note?: string;
}

export interface SourceGroup {
  id: string;
  title: string;
  note?: string;
  sources: SourceRow[];
}

export interface SourcesDto {
  generatedAt: string;
  groups: SourceGroup[];
  tally: Record<'answering' | 'late' | 'silent' | 'never' | 'off', number>;
  /** One sentence, before any table. Null when there is nothing to raise. */
  headline: string | null;
}

/** Human cadence, for a column that is read rather than computed with. */
export function cadenceText(cadenceMs: number | null): string {
  if (cadenceMs === null) return '—';
  const seconds = Math.round(cadenceMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

export function tallyOf(groups: SourceGroup[]): SourcesDto['tally'] {
  const tally = { answering: 0, late: 0, silent: 0, never: 0, off: 0 };
  for (const group of groups) {
    for (const source of group.sources) {
      if (source.state === 'live') tally.answering += 1;
      else if (source.state === 'partial' || source.state === 'late') tally.late += 1;
      else if (source.state === 'silent') tally.silent += 1;
      else if (source.state === 'never') tally.never += 1;
      else tally.off += 1;
    }
  }
  return tally;
}

/**
 * The sentence at the top.
 *
 * Names what is wrong rather than counting it, because "3 of 12 sources are degraded" is a
 * status badge and "the charger has been quiet since yesterday" is something a person can
 * act on. Silent and never lead; lateness alone is not worth a headline, since one missed
 * poll is a normal Tuesday.
 */
export function headlineFor(groups: SourceGroup[]): string | null {
  const all = groups.flatMap((group) => group.sources);
  const silent = all.filter((source) => source.state === 'silent');
  const never = all.filter((source) => source.state === 'never');
  if (silent.length === 0 && never.length === 0) {
    const expected = all.filter((source) => source.state !== 'off').length;
    return expected === 0 ? null : `All ${expected} sources are reporting.`;
  }
  const parts: string[] = [];
  if (silent.length === 1) parts.push(`${silent[0].name} has stopped reporting`);
  else if (silent.length > 1) parts.push(`${silent.length} sources have stopped reporting`);
  if (never.length === 1) parts.push(`${never[0].name} has never answered once`);
  else if (never.length > 1) parts.push(`${never.length} adopted devices have never answered once`);
  return `${parts.join(', and ')}.`;
}
