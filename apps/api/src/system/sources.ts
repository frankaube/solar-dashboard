/**
 * Whether the dashboard is being told anything, as distinct from whether the array is
 * faulty: a source that stops reporting leaves its last reading on screen.
 */

export type SourceState = 'live' | 'partial' | 'late' | 'silent' | 'never' | 'off';

/** One poll window: it answered, it should have and did not, or nothing was expected. */
export type Attempt = 'ok' | 'miss' | 'none';

/** Floors, not just multiples: a 30 s-cadence charger would otherwise read silent after six minutes. */
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
   * On time, but not with everything it should carry — the gateway replies punctually
   * with panels missing from the reply. Calling that late points at the network.
   */
  incomplete?: boolean;
}

export function stateOf(timing: SourceTiming, now: Date = new Date()): SourceState {
  if (!timing.configured) return 'off';
  // Never is its own answer, not a very old "silent": waiting will not fix it.
  if (timing.lastSeenAt === null) return 'never';
  if (timing.cadenceMs === null) return timing.incomplete ? 'partial' : 'live';

  const age = now.getTime() - timing.lastSeenAt.getTime();
  const silentAfter = Math.max(timing.cadenceMs * SILENT_AFTER, SILENT_FLOOR_MS);
  const lateAfter = Math.max(timing.cadenceMs * LATE_AFTER, LATE_FLOOR_MS);
  // Silence outranks incompleteness.
  if (age > silentAfter) return 'silent';
  if (age > lateAfter) return 'late';
  return timing.incomplete ? 'partial' : 'live';
}

/**
 * Poll windows oldest first, derived from stored readings rather than an attempt log. The
 * limit: a poll that succeeded and stored nothing looks like one that never ran.
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
    // Inclusive of the window's end, so a boundary reading counts once, for the newer one.
    out.push(stamps.some((at) => at > from && at <= to) ? 'ok' : 'miss');
  }
  return out;
}

/** An empty strip, not a row of failures, for a source nothing is expected of. */
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

/** Names what is wrong rather than counting it. Silent and never lead; lateness does not. */
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
