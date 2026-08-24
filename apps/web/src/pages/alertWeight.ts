import { Alert } from '../api';

/*
  How loud is a fault allowed to be?

  The Overview hero's widest line is an answer to "how is the roof doing". It used to be
  surrendered to any open alert, so a charger that had been unreachable for three days owned
  it — and would own it tomorrow, and the day after. A fault that never clears is not news.
  It is a condition, and a condition belongs somewhere you can check rather than somewhere
  you have to read.

  The split is not severity and it is not age. It is whether the fault is costing production
  RIGHT NOW. A dark array is money leaving the roof this minute and it will clear, so it is
  news. A silent charger is a gap in the records: worth fixing, worth seeing, not worth the
  widest line on the page every morning.
*/

/**
 * The types that are allowed to take the headline.
 *
 * Each one means the roof is making less than it should, this minute. Everything else is a
 * hole in what can be *seen* rather than in what is being *made* — the output of a silent
 * inverter is still inside the system total, it just cannot be attributed.
 *
 * Deliberately a list of what is loud rather than what is quiet: a type added later starts
 * quiet, which is the safe direction to be wrong in for a line that only holds one thing.
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

/**
 * Serious before warning, then oldest first.
 *
 * The one that has been wrong longest is the one that matters, not the one that happened to
 * fire last.
 */
function worstFirst(a: Alert, b: Alert): number {
  if (a.severity !== b.severity) return a.severity === 'serious' ? -1 : 1;
  return a.openedAt.localeCompare(b.openedAt);
}

/**
 * Split the open alerts into the one that may take the hero and the rest.
 *
 * Acknowledging demotes. That is the whole point of the button: you have seen it, you have
 * decided what to do about it, and it should stop asking. This is deliberately the owner's
 * signal rather than a timer — a "quiet after 24 hours" rule would have silenced a genuinely
 * dark array on day two, which is exactly when it has cost the most.
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
 * Alert messages are written for the place you land after clicking, so they carry their own
 * reassurance: "…— its figures are frozen at the last reading", "…, but their 2016 W is still
 * in the system total". Two of those joined together overran the standing line by a factor of
 * four and got cut mid-word by the ellipsis.
 *
 * The first clause is reliably the claim itself, because that is how these messages are
 * written: what is wrong, then what it means. A comma must be followed by a space to count,
 * so a thousands separator does not truncate "12,000 Wh" to "12".
 */
function firstClause(message: string): string {
  const cut = [message.indexOf(' — '), message.indexOf(', ')].filter((at) => at > 0);
  return cut.length ? message.slice(0, Math.min(...cut)) : message;
}

/**
 * The standing line: name them, do not just count them.
 *
 * "2 things to look at" spends a line saying nothing you can act on — you cannot tell whether
 * it is worth clicking. Two get named; beyond that the first is named and the rest counted,
 * because a list long enough to wrap has stopped being a glance.
 */
export function standingLine(standing: Alert[]): string {
  if (!standing.length) return '';
  const subjects = standing.map((alert) => firstClause(alert.message));
  if (subjects.length === 1) return subjects[0];
  if (subjects.length === 2) return `${subjects[0]} · ${subjects[1]}`;
  return `${subjects[0]} · and ${subjects.length - 1} more`;
}
