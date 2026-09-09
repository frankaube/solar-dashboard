/**
 * Credits about to be forfeited, and what draw would absorb them.
 *
 * Banked export credits expire on a fixed date each year (31 March under this tariff) and
 * whatever is left is gone. Unlike `credit-bank.ts`, which projects from balances typed off
 * bills, this works from imported daily meter data.
 *
 * ADVISORY ONLY: it never commands a charger. The arithmetic rests on a projection, and
 * drawing power costs money if it is wrong.
 */

const DAY_MS = 86_400_000;

/**
 * How many recent days the daily rate is taken from. Four weeks: long enough that a run of
 * cloud does not set the trend, short enough that a season change is not averaged away.
 */
export const TREND_DAYS = 28;
/** Below this there is no trend, only noise. */
export const MIN_TREND_DAYS = 7;

/** Ignore a forfeiture smaller than this — the projection's error bars swallow it. */
export const MIN_WORTH_MENTIONING_KWH = 25;

export interface MeterDay {
  date: string;
  importedKwh: number;
  exportedKwh: number;
  unmetered?: boolean;
}

export interface DumpPlan {
  /** kWh projected to be forfeited on the expiry date. Null when it cannot be projected. */
  atRiskKwh: number | null;
  /** What that energy would have been worth, at the redeem rate. */
  atRiskValue: number | null;
  daysRemaining: number;
  /** Net kWh banked per day over the trend window — negative means the bank is draining. */
  dailyNetKwh: number | null;
  /** Extra draw per day that would absorb the surplus before it expires. */
  dumpKwhPerDay: number | null;
  /** How many hours of charging that is, at this charger's measured average power. */
  dumpHoursPerDay: number | null;
  /** True when there is something worth acting on. */
  actionable: boolean;
  reason: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Net kWh a day, from the meter. Unmetered days are excluded: the meter recorded no export
 * while the array produced, so counting them makes the bank look like it is draining faster.
 */
export function dailyNet(days: MeterDay[], through: Date): { rate: number | null; days: number } {
  const cutoff = through.getTime() - TREND_DAYS * DAY_MS;
  const usable = days.filter((day) => {
    if (day.unmetered) return false;
    const at = Date.parse(`${day.date}T00:00:00Z`);
    return Number.isFinite(at) && at >= cutoff && at <= through.getTime();
  });
  if (usable.length < MIN_TREND_DAYS) return { rate: null, days: usable.length };
  const net = usable.reduce((total, day) => total + day.exportedKwh - day.importedKwh, 0);
  return { rate: net / usable.length, days: usable.length };
}

/**
 * Average charging power actually observed, in kW. Measured, not assumed. Sessions shorter
 * than a few minutes are skipped: a 90-second plug-in that drew nothing divides out to 40 kW.
 */
export function averageChargeKw(
  sessions: Array<{ startedAt: string; endedAt: string; energyWh: number }>,
): number | null {
  let energyWh = 0;
  let hours = 0;
  for (const session of sessions) {
    const span = Date.parse(session.endedAt) - Date.parse(session.startedAt);
    if (!Number.isFinite(span) || span < 5 * 60_000) continue;
    if (!(session.energyWh > 0)) continue;
    energyWh += session.energyWh;
    hours += span / 3_600_000;
  }
  if (hours <= 0) return null;
  return energyWh / 1000 / hours;
}

/**
 * What is at risk, and what draw would absorb it. Needs a balance: a rate alone says which
 * way the bank is going, not how much is in it.
 */
export function planDump(input: {
  /** Known balance in kWh, from a bill or derived from the meter. Null when unknown. */
  balanceKwh: number | null;
  expiresAt: Date;
  now: Date;
  meterDays: MeterDay[];
  redeemRatePerKwh: number;
  averageChargeKw?: number | null;
}): DumpPlan {
  const daysRemaining = Math.max(
    0,
    Math.ceil((input.expiresAt.getTime() - input.now.getTime()) / DAY_MS),
  );
  const { rate, days } = dailyNet(input.meterDays, input.now);

  const nothing = (reason: string): DumpPlan => ({
    atRiskKwh: null,
    atRiskValue: null,
    daysRemaining,
    dailyNetKwh: rate === null ? null : round1(rate),
    dumpKwhPerDay: null,
    dumpHoursPerDay: null,
    actionable: false,
    reason,
  });

  if (input.balanceKwh === null) {
    return nothing(
      'No balance to plan against. Enter one from a bill and this can project it forward from your meter data.',
    );
  }
  if (rate === null) {
    return nothing(
      `Only ${days} metered day(s) in the last ${TREND_DAYS} — not enough to project a trend. Import a more recent usage export.`,
    );
  }

  // Where the balance lands on the expiry date, clamped at zero: a bank does not go negative.
  const projected = Math.max(0, input.balanceKwh + rate * daysRemaining);
  const atRiskKwh = round1(projected);
  const atRiskValue = Math.round(projected * input.redeemRatePerKwh * 100) / 100;

  if (projected < MIN_WORTH_MENTIONING_KWH) {
    return {
      ...nothing(
        projected <= 0
          ? `On track to use the whole bank before ${input.expiresAt.toISOString().slice(0, 10)}.`
          : `About ${atRiskKwh} kWh may be left over — small enough that the projection cannot really tell.`,
      ),
      atRiskKwh,
      atRiskValue,
    };
  }

  const dumpKwhPerDay = daysRemaining > 0 ? projected / daysRemaining : projected;
  const kw = input.averageChargeKw ?? null;
  return {
    atRiskKwh,
    atRiskValue,
    daysRemaining,
    dailyNetKwh: round1(rate),
    dumpKwhPerDay: round1(dumpKwhPerDay),
    dumpHoursPerDay: kw && kw > 0 ? round1(dumpKwhPerDay / kw) : null,
    actionable: true,
    reason:
      `About ${atRiskKwh} kWh is on track to expire, worth ${atRiskValue.toFixed(2)}. ` +
      `Using an extra ${round1(dumpKwhPerDay)} kWh a day between now and then would absorb it.`,
  };
}
