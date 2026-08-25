import { Alert } from '../api';

/*
  How loud is a fault allowed to be?

  The split is not severity and it is not age: it is whether the fault is costing production
  RIGHT NOW. A dark array is money leaving the roof this minute and it will clear. A silent
  charger is a gap in the records — worth seeing, not worth the Overview hero's widest line
  every morning until somebody fixes it.
*/

/**
 * The types that are allowed to take the headline: each means the roof is making less than
 * it should, this minute. Everything else is a hole in what can be *seen* rather than in
 * what is being *made*.
 *
 * A list of what is loud, not what is quiet, so a type added later starts quiet.
 */
const COSTS_PRODUCTION_NOW: ReadonlySet<string> = new Set([
  /** Bright sky, nothing coming out. */
  'array_dark',
  /** An inverter has stopped while the fleet works. */
  'inverter_offline',
  /** Snow on the panels — loud because it clears, and because it explains a bad day. */
  'snow_cover',
]);

export interface WeighedAlerts {
  /** At most one, and only ever something actively costing production. */
  headline: Alert | null;
  /** Everything else that is open: real, worth seeing, not worth shouting. */
  standing: Alert[];
}

/** Serious before warning, then oldest first — longest wrong outranks most recently fired. */
function worstFirst(a: Alert, b: Alert): number {
  if (a.severity !== b.severity) return a.severity === 'serious' ? -1 : 1;
  return a.openedAt.localeCompare(b.openedAt);
}

/**
 * Split the open alerts into the one that may take the hero and the rest.
 *
 * Acknowledging demotes — the owner's signal rather than a timer, since a "quiet after 24
 * hours" rule would silence a genuinely dark array on day two.
 */
export function weighAlerts(active: Alert[]): WeighedAlerts {
  const loud = active
    .filter((alert) => COSTS_PRODUCTION_NOW.has(alert.type) && !alert.ackedAt)
    .sort(worstFirst);
  const headline = loud[0] ?? null;
  const standing = active.filter((alert) => alert !== headline).sort(worstFirst);
  return { headline, standing };
}

/**
 * The claim an alert makes, without the paragraph explaining it.
 *
 * Alert messages are written what-is-wrong-then-what-it-means, so the first clause is
 * reliably the claim. A comma must be followed by a space to count as a break, so a
 * thousands separator does not truncate "12,000 Wh" to "12".
 */
function firstClause(message: string): string {
  const cut = [message.indexOf(' — '), message.indexOf(', ')].filter((at) => at > 0);
  return cut.length ? message.slice(0, Math.min(...cut)) : message;
}

/**
 * The standing line: name them, do not just count them. Two get named; beyond that the
 * first is named and the rest counted, so the line cannot wrap.
 */
export function standingLine(standing: Alert[]): string {
  if (!standing.length) return '';
  const subjects = standing.map((alert) => firstClause(alert.message));
  if (subjects.length === 1) return subjects[0];
  if (subjects.length === 2) return `${subjects[0]} · ${subjects[1]}`;
  return `${subjects[0]} · and ${subjects.length - 1} more`;
}
