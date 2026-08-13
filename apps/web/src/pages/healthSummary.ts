import { Alert, Census, CensusFinding } from '../api';

/**
 * One ranked list of everything wrong, and a verdict you can read in a second.
 *
 * The Health page used to present three systems separately — the alert engine, the array
 * census, and the fleet vitals — each explaining itself in full prose. Six census findings
 * carried a paragraph apiece, so the page ran to roughly seven hundred words and answered
 * "is anything wrong?" nowhere. You had to read it to find out, which is precisely backwards
 * for a page whose entire job is to be glanced at.
 *
 * The split was an implementation detail leaking into the interface: nobody looking at this
 * page cares whether a problem was noticed by the alert engine or by the census. They care
 * how bad it is. So both become `Issue`s in one list, sorted by severity, one line each,
 * with the prose behind a disclosure for the moment somebody actually wants it.
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
 * Acknowledged alerts stay in the list rather than disappearing — acknowledging says "I
 * have seen this", not "this is fixed", and a page that hid them would report all clear
 * over a dead inverter somebody nodded at last Tuesday. They sort below their unacknowledged
 * peers instead, and the verdict above counts them separately.
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

  /*
    Census findings the alert engine already raised are dropped.

    The census publishes its findings as alert candidates too, so an array-size mismatch
    arrives twice — once as an open alert and once as a finding. Listing both would have the
    page report four problems where there are three, and the duplicate is not obvious on
    screen because the two systems word it differently.
  */
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
 * Ranked by the worst thing present, not by how many there are: one dead inverter matters
 * more than five notes about panel counts, and an average would bury it. Informational
 * findings do not colour the verdict at all — they are observations worth settling, and a
 * page that goes amber over "worth checking your contract" is a page whose amber means
 * nothing by the second week.
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
      detail: `Nothing wrong. ${plural(info, 'note')} worth settling when you have a moment${ackNote}.`,
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
 * Deliberately separate from the alert list. A page saying "all clear" off readings that
 * stopped arriving three hours ago is the one failure a health page must never have — it
 * is not reporting health, it is reporting the last health it saw, and the two look
 * identical until somebody checks the timestamp nobody reads.
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
 * The issue card's heading.
 *
 * Counts what is outstanding rather than how many rows are rendered — "7 to look at" over a
 * list where three are acknowledged asks for work that has already been triaged, which is
 * how a page teaches somebody to stop reading its headings.
 */
export function issueHeading(issues: Issue[]): string {
  const live = issues.filter((issue) => !issue.acknowledged).length;
  const acked = issues.length - live;
  if (live === 0) return `${acked} acknowledged`;
  return `${live} to look at${acked > 0 ? ` · ${acked} acknowledged` : ''}`;
}
