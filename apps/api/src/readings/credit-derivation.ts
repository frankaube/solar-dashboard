/**
 * The credit bank, derived from the utility's own meter instead of waiting for a bill.
 *
 * `credit-bank.ts` projects forward from balances typed off bills, and its header says why
 * they have to be typed: "this app sees production, not what the house imports or exports."
 * That stopped being true the moment a usage export could be imported. Both directions are
 * now known, per day, from the meter the bill is calculated from — so the balance between
 * two bills is arithmetic rather than a blank.
 *
 * What it still cannot do is invent the starting point. A bank balance is a running total
 * that predates anything this app has seen, so without one reading off a bill to anchor to,
 * the honest answer is the *change* since the meter data begins and an explicit refusal to
 * call it a balance. Those two are reported as different things, because a change presented
 * as a balance is wrong by exactly whatever was already in the bank.
 */

const MS_PER_DAY = 86_400_000;

export interface MeterDay {
  date: string;
  importedKwh: number;
  exportedKwh: number;
  /** True when the array produced and the meter recorded no export — see utility-usage.ts. */
  unmetered?: boolean;
}

/** A balance read off a bill: the only thing that can anchor a running total. */
export interface BankAnchor {
  date: string;
  balanceKwh: number;
}

export type DerivationBasis = 'derived' | 'change-only' | 'none';

export interface DerivedBank {
  /** What the bank holds, or null when nothing anchors the count. */
  balanceKwh: number | null;
  anchor: BankAnchor | null;
  /** Exported minus imported over the covered days. Negative means the bank was drawn on. */
  netKwh: number;
  /** Newest meter day counted. */
  throughDate: string | null;
  /** Days between the anchor and `throughDate` with no meter reading at all. */
  missingDays: number;
  /** True when the running balance hit zero and consumption continued past it. */
  emptied: boolean;
  /**
   * Energy the array produced on days the meter recorded no export.
   *
   * Not part of the balance and never will be — the utility did not count it, so it is not
   * in their bank either. Carried because a figure that is correct and lower than expected
   * needs its explanation attached, or it reads as a bug in this arithmetic.
   */
  neverCreditedKwh: number;
  basis: DerivationBasis;
  summary: string;
}

const round = (value: number): number => Math.round(value * 10) / 10;

const dayCount = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);

/**
 * Fold the meter days into a bank balance.
 *
 * Day by day rather than one net sum, because the bank cannot go negative: a month of
 * heavy import empties it and the rest is bought with money, and netting the whole period
 * in one subtraction would carry an overdraft forward that never existed. `emptied` says
 * when that happened, since a balance of zero reached that way means something different
 * from a balance of zero that simply has not been filled.
 */
export function deriveBank(
  anchor: BankAnchor | null,
  days: MeterDay[],
  producedKwhByDate: Map<string, number> = new Map(),
): DerivedBank {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const counted = anchor ? sorted.filter((day) => day.date > anchor.date) : sorted;

  const neverCreditedKwh = round(
    sorted
      .filter((day) => day.unmetered)
      .reduce((total, day) => total + (producedKwhByDate.get(day.date) ?? 0), 0),
  );

  if (counted.length === 0) {
    return {
      balanceKwh: anchor ? anchor.balanceKwh : null,
      anchor,
      netKwh: 0,
      throughDate: null,
      missingDays: 0,
      emptied: false,
      neverCreditedKwh,
      basis: anchor ? 'derived' : 'none',
      summary: anchor
        ? `No meter data since the ${anchor.date} balance, so it still stands at ${anchor.balanceKwh} kWh.`
        : 'No meter data imported yet, and no balance read off a bill to count from.',
    };
  }

  const throughDate = counted[counted.length - 1].date;
  const netKwh = round(
    counted.reduce((total, day) => total + day.exportedKwh - day.importedKwh, 0),
  );

  /*
    Gaps matter more than they look. A derived balance over a window missing a fortnight is
    not slightly wrong — the missing days are almost always high-consumption ones nobody
    exported on, so the omission is biased upward rather than random.
  */
  const spanFrom = anchor ? anchor.date : counted[0].date;
  const missingDays = Math.max(0, dayCount(spanFrom, throughDate) - counted.length + (anchor ? 0 : 1));

  if (!anchor) {
    return {
      balanceKwh: null,
      anchor: null,
      netKwh,
      throughDate,
      missingDays,
      emptied: false,
      neverCreditedKwh,
      basis: 'change-only',
      summary:
        `Over the ${counted.length} metered days to ${throughDate} you ` +
        `${netKwh >= 0 ? `banked ${netKwh} kWh more than you drew` : `drew ${Math.abs(netKwh)} kWh more than you banked`}. ` +
        'That is the change, not the balance — enter a balance from a bill and this can count forward from it.',
    };
  }

  let balance = anchor.balanceKwh;
  let emptied = false;
  for (const day of counted) {
    balance += day.exportedKwh - day.importedKwh;
    if (balance < 0) {
      // The bank ran out and the rest was bought. It does not go negative; you pay cash.
      balance = 0;
      emptied = true;
    }
  }

  return {
    balanceKwh: round(balance),
    anchor,
    netKwh,
    throughDate,
    missingDays,
    emptied,
    neverCreditedKwh,
    basis: 'derived',
    summary:
      `${round(balance)} kWh, counted from the ${anchor.balanceKwh} kWh on your ${anchor.date} bill ` +
      `and the ${counted.length} metered days since.` +
      (emptied ? ' The bank emptied at least once in that window; anything past it was bought.' : '') +
      (missingDays > 0 ? ` ${missingDays} day(s) in that span have no meter reading, so this is approximate.` : ''),
  };
}
