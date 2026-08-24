/**
 * Credits that are about to be forfeited, and what it would take to not lose them.
 *
 * Banked export credits expire on a fixed date every year — 31 March under this tariff —
 * and whatever is left is simply gone. That deadline is the one piece of this app where a
 * number on a screen has an obvious action attached: energy drawn before the date is free,
 * energy drawn after it is bought.
 *
 * `credit-bank.ts` already projects a balance forward, but only from balances typed off
 * bills, and it refuses under ninety days of them — which is the honest answer when two
 * readings a fortnight apart are all there is. Imported meter data changes the arithmetic
 * completely: it is daily, it comes from the meter the bill is calculated from, and a
 * fortnight of it says more about the trend than four bills do.
 *
 * ADVISORY ONLY, deliberately. This computes what is at risk and what draw would absorb
 * it; it never commands a charger. Drawing power costs money if the arithmetic here is
 * wrong, and the arithmetic rests on a projection — so the decision stays with the owner.
 */

const DAY_MS = 86_400_000;

/**
 * How many recent days the daily rate is taken from.
 *
 * Four weeks: long enough that a run of cloud does not set the trend, short enough that a
 * season change is not averaged away. The rate is a projection either way, and this is
 * stated wherever the number is shown.
 */
export const TREND_DAYS = 28;
/** Below this there is no trend, only noise. */
export const MIN_TREND_DAYS = 7;

/**
 * Ignore a forfeiture smaller than this.
 *
 * A projection is not accurate to the kilowatt-hour, and telling somebody to go and use
 * three of them is worse than saying nothing — it spends their attention on an amount the
 * error bars swallow.
 */
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
 * Net kWh a day, from the meter.
 *
 * Unmetered days are excluded rather than counted as heavy import: they are days the meter
 * recorded no export while the array produced, so their net is wrong in the one direction
 * that would make the bank look like it is draining faster than it is.
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
 * Average charging power actually observed, in kW.
 *
 * Measured rather than assumed, because "7.4 kW" is a property of somebody else's charger.
 * Sessions shorter than a few minutes are skipped — a plug-in that drew nothing for ninety
 * seconds produces a division that says 40 kW.
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
 * What is at risk, and what draw would absorb it.
 *
 * Needs a balance to work from — a rate alone cannot say how much is in the bank, only
 * which way it is going. Without one the honest answer is that there is nothing to plan
 * against, and the reason says how to get one.
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

  /*
    Where the balance lands on the expiry date, clamped at zero: a bank does not go
    negative, it empties and the rest is bought with money.
  */
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
