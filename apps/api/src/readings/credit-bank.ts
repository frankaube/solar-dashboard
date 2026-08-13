/**
 * Banked export credits, and the date they stop existing.
 *
 * Under 1:1 net metering a surplus kWh is banked rather than paid for, and the bank is
 * emptied on a fixed calendar date — 31 March for NB Power. Anything still in it is
 * forfeited. That is real money with a deadline, and nothing on a utility bill draws
 * attention to it: the balance is printed as a number with no indication that it expires.
 *
 * WHAT THIS CANNOT DO, AND WHY IT SAYS SO
 *
 * The app measures production. It does not measure what the house imports or exports —
 * that needs a meter at the service entrance, which most installs do not have. So the
 * balance cannot be derived here; it is read off a bill and entered.
 *
 * Nor can a projection be invented from a few weeks of summer readings. Credits build
 * through summer and drain through winter, so extrapolating an August trend to March is
 * not a forecast, it is a straight line drawn through a season it knows nothing about.
 * This module refuses to project across a winter it has never seen, and says which case
 * it is in rather than producing a confident number from nothing.
 */

export interface CreditReading {
  /** When the balance was read, from a bill or the meter. */
  readAt: Date;
  balanceKwh: number;
}

export interface ExpiryRule {
  /** 1-12. */
  month: number;
  /** Day of month the bank empties, inclusive — the balance is gone after it. */
  day: number;
}

/** NB Power: the banking year ends 31 March. */
export const DEFAULT_EXPIRY: ExpiryRule = { month: 3, day: 31 };

const DAY_MS = 86_400_000;

/**
 * The next date the bank empties, at or after `now`.
 *
 * Compared as UTC date parts rather than instants: an expiry is a calendar date on a
 * utility's bill, not a moment, and doing the arithmetic in local time would move it by a
 * day for anyone east of Greenwich.
 */
export function nextExpiry(now: Date, rule: ExpiryRule = DEFAULT_EXPIRY): Date {
  const year = now.getUTCFullYear();
  const thisYear = new Date(Date.UTC(year, rule.month - 1, rule.day, 23, 59, 59));
  return now.getTime() <= thisYear.getTime()
    ? thisYear
    : new Date(Date.UTC(year + 1, rule.month - 1, rule.day, 23, 59, 59));
}

export function daysUntil(now: Date, expiry: Date): number {
  return Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS));
}

export type ProjectionBasis =
  | 'none'
  | 'single-reading'
  | 'too-short'
  | 'crosses-unseen-winter'
  | 'trend';

export interface BankStatus {
  balanceKwh: number | null;
  readAt: string | null;
  expiresAt: string;
  daysRemaining: number;
  /** Projected balance on the expiry date, or null when it cannot honestly be projected. */
  projectedKwh: number | null;
  /** kWh expected to be forfeited. Null whenever projectedKwh is. */
  atRiskKwh: number | null;
  atRiskValue: number | null;
  basis: ProjectionBasis;
  /** One sentence, always set, explaining the state — including why there is no number. */
  message: string;
}

/**
 * How much history a projection needs before it means anything.
 *
 * Two readings a fortnight apart give a slope, and that slope says nothing about March.
 * Ninety days is not a season either, but it is enough to have seen the balance turn —
 * and below it the honest answer is that there is no answer.
 */
const MIN_SPAN_DAYS = 90;

function slopePerDay(readings: CreditReading[]): number {
  // Least squares over (days, balance). A two-point slope swings wildly on one odd bill;
  // a fit over everything available is steadier and no harder to explain.
  const t0 = readings[0].readAt.getTime();
  const points = readings.map((r) => ({
    x: (r.readAt.getTime() - t0) / DAY_MS,
    y: r.balanceKwh,
  }));
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

/** Does the window between the last reading and expiry include months we have never seen? */
function crossesUnseenWinter(readings: CreditReading[], expiry: Date): boolean {
  const seen = new Set(readings.map((r) => r.readAt.getUTCMonth()));
  const last = readings[readings.length - 1].readAt;
  const cursor = new Date(last.getTime());
  while (cursor.getTime() < expiry.getTime()) {
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    if (cursor.getTime() > expiry.getTime()) break;
    if (!seen.has(cursor.getUTCMonth())) return true;
  }
  return false;
}

export function bankStatus({
  readings,
  now,
  redeemedRatePerKwh,
  rule = DEFAULT_EXPIRY,
}: {
  readings: CreditReading[];
  now: Date;
  /** What a redeemed kWh is worth — pre-tax retail under net metering. */
  redeemedRatePerKwh: number;
  rule?: ExpiryRule;
}): BankStatus {
  const expiry = nextExpiry(now, rule);
  const days = daysUntil(now, expiry);
  const sorted = [...readings].sort((a, b) => a.readAt.getTime() - b.readAt.getTime());
  const latest = sorted[sorted.length - 1] ?? null;

  const base = {
    balanceKwh: latest?.balanceKwh ?? null,
    readAt: latest?.readAt.toISOString() ?? null,
    expiresAt: expiry.toISOString(),
    daysRemaining: days,
    projectedKwh: null,
    atRiskKwh: null,
    atRiskValue: null,
  };

  if (sorted.length === 0) {
    return {
      ...base,
      basis: 'none',
      message: `Your utility banks surplus kWh and empties the bank on ${expiry.toISOString().slice(0, 10)}. Enter the balance from a bill to start tracking it.`,
    };
  }

  if (sorted.length === 1) {
    return {
      ...base,
      basis: 'single-reading',
      message: `${Math.round(latest!.balanceKwh)} kWh banked. One reading cannot show a trend — add the next bill and this will start projecting.`,
    };
  }

  const spanDays = (latest!.readAt.getTime() - sorted[0].readAt.getTime()) / DAY_MS;
  if (spanDays < MIN_SPAN_DAYS) {
    return {
      ...base,
      basis: 'too-short',
      message: `${Math.round(latest!.balanceKwh)} kWh banked, expiring in ${days} days. ${Math.round(spanDays)} days of readings is not enough to project across a season.`,
    };
  }

  if (crossesUnseenWinter(sorted, expiry)) {
    return {
      ...base,
      basis: 'crosses-unseen-winter',
      message: `${Math.round(latest!.balanceKwh)} kWh banked, expiring in ${days} days. Projecting there would cross months this install has never recorded, so no forecast is offered — credits build in summer and drain in winter, and a straight line through that is guesswork.`,
    };
  }

  const perDay = slopePerDay(sorted);
  const daysFromLast = (expiry.getTime() - latest!.readAt.getTime()) / DAY_MS;
  const projected = Math.max(0, latest!.balanceKwh + perDay * daysFromLast);
  const atRisk = Math.max(0, projected);

  return {
    ...base,
    projectedKwh: Math.round(projected),
    atRiskKwh: Math.round(atRisk),
    atRiskValue: Number((atRisk * redeemedRatePerKwh).toFixed(2)),
    basis: 'trend',
    message:
      atRisk > 0
        ? `About ${Math.round(atRisk)} kWh looks likely to still be banked on ${expiry.toISOString().slice(0, 10)}, when it is forfeited — roughly $${(atRisk * redeemedRatePerKwh).toFixed(2)} at the rate a credit redeems for. Using more of it before then is worth more than banking more.`
        : `On the current trend the bank empties before ${expiry.toISOString().slice(0, 10)}, so nothing is forfeited.`,
  };
}
