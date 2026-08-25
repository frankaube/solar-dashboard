import { Alert, Census, CensusFinding } from '../api';

/**
 * One ranked list of everything wrong, and a verdict you can read in a second.
 *
 * Alerts and census findings both become `Issue`s in one list sorted by severity, one line
 * each, with the prose behind a disclosure — which system noticed a problem is an
 * implementation detail.
 */

export type Rank = 'ok' | 'info' | 'warning' | 'serious';

const ORDER: Record<Rank, number> = { serious: 0, warning: 1, info: 2, ok: 3 };

export interface Issue {
  key: string;
  rank: Rank;
  title: string;
  /** The paragraph. Present for most, and never shown until asked for. */
  detail: string | null;
  /** Alerts can be acknowledged and located; census findings cannot. */
  alertId: number | null;
  /** ISO instant the alert opened. Census findings are conditions, not events. */
  since: string | null;
  acknowledged: boolean;
  /** True when the alert names a specific panel, so "show on roof" can be offered. */
  locatable: boolean;
}

const rankOf = (severity: string): Rank =>
  severity === 'serious' ? 'serious' : severity === 'warning' ? 'warning' : 'info';

/**
 * Every current problem, worst first.
 *
 * Acknowledged alerts stay in the list — acknowledging says "I have seen this", not "this
 * is fixed". They sort below unacknowledged peers, and the verdict counts them separately.
 */
export function mergeIssues(alerts: Alert[], census: Census | null): Issue[] {
  const fromAlerts: Issue[] = alerts.map((alert) => ({
    key: `alert-${alert.id}`,
    rank: rankOf(alert.severity),
    title: alert.message,
    detail: null,
    alertId: alert.id,
    since: alert.openedAt,
    acknowledged: Boolean(alert.ackedAt),
    // A subject like `panel:1420A38A8982:2` names hardware on the roof; `utility-usage`
    // does not, and offering to locate it would lead somewhere with nothing to show.
    locatable: alert.subjectKey.includes(':'),
  }));

  // Census findings the alert engine already raised are dropped: the census publishes its
  // findings as alert candidates too, so each arrives twice, worded differently.
  const seen = new Set(alerts.map((alert) => alert.message));
  const fromCensus: Issue[] = (census?.findings ?? [])
    .filter((finding: CensusFinding) => !seen.has(finding.headline))
    .map((finding) => ({
      key: `census-${finding.id}`,
      rank: rankOf(finding.severity),
      title: finding.headline,
      detail: finding.detail,
      alertId: null,
      since: null,
      acknowledged: false,
      locatable: false,
    }));

  return [...fromAlerts, ...fromCensus].sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
    return ORDER[a.rank] - ORDER[b.rank];
  });
}

export interface Verdict {
  rank: Rank;
  /** Four words at most. This is the line that has to be readable at a glance. */
  headline: string;
  /** The count breakdown, or the reassurance. One short sentence. */
  detail: string;
}

/**
 * The answer to "is anything wrong", before any of the explaining.
 *
 * Ranked by the worst thing present, not by how many there are. Informational findings do
 * not colour the verdict at all.
 */
export function verdict(issues: Issue[]): Verdict {
  const live = issues.filter((issue) => !issue.acknowledged);
  const serious = live.filter((issue) => issue.rank === 'serious').length;
  const warning = live.filter((issue) => issue.rank === 'warning').length;
  const info = live.filter((issue) => issue.rank === 'info').length;
  const acked = issues.length - live.length;

  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const ackNote = acked > 0 ? `, ${acked} acknowledged` : '';

  if (serious > 0) {
    const rest = warning > 0 ? ` and ${plural(warning, 'warning')}` : '';
    return {
      rank: 'serious',
      headline: 'Needs attention',
      detail: `${plural(serious, 'serious problem')}${rest}${ackNote}.`,
    };
  }
  if (warning > 0) {
    return {
      rank: 'warning',
      headline: 'Worth a look',
      detail: `${plural(warning, 'warning')}${info > 0 ? `, ${info} note${info === 1 ? '' : 's'}` : ''}${ackNote}.`,
    };
  }
  if (info > 0) {
    return {
      rank: 'info',
      headline: 'All clear',
      detail: `Nothing wrong. ${plural(info, 'note')} worth settling${ackNote}.`,
    };
  }
  return {
    rank: 'ok',
    headline: 'All clear',
    detail: acked
      ? `Nothing open.${ackNote.replace(',', '')}.`
      : 'Every inverter and panel is reporting, and nothing has drifted.',
  };
}

/**
 * Whether the app is still hearing from the array at all.
 *
 * Deliberately separate from the alert list: "all clear" computed off readings that stopped
 * arriving three hours ago reports the last health seen, not the current one.
 */
export function pollFreshness(
  updatedAt: string | null,
  now: number,
  pollIntervalMs = 5 * 60_000,
): { stale: boolean; text: string } {
  if (!updatedAt) return { stale: true, text: 'no readings yet' };
  const ageMs = now - new Date(updatedAt).getTime();
  const minutes = Math.floor(ageMs / 60_000);
  // Three intervals: one missed poll is a blip, three is a pattern.
  const stale = ageMs > pollIntervalMs * 3;
  if (minutes < 1) return { stale, text: 'just now' };
  if (minutes < 60) return { stale, text: `${minutes} min ago` };
  const hours = Math.floor(minutes / 60);
  return { stale, text: `${hours} h ago` };
}

/**
 * The issue card's heading. Counts what is outstanding rather than how many rows are
 * rendered, so acknowledged issues are not asked for again.
 */
export function issueHeading(issues: Issue[]): string {
  const live = issues.filter((issue) => !issue.acknowledged).length;
  const acked = issues.length - live;
  if (live === 0) return `${acked} acknowledged`;
  return `${live} to look at${acked > 0 ? ` · ${acked} acknowledged` : ''}`;
}
