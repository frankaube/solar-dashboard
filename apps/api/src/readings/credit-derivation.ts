/**
 * The credit bank, derived from imported utility meter data instead of waiting for a bill.
 * Both directions are known per day from the meter the bill is calculated from, so the
 * balance between two bills is arithmetic.
 *
 * The starting point cannot be invented: a bank balance is a running total predating
 * anything this app has seen. Without a bill to anchor to, this reports the CHANGE since the
 * meter data begins — presenting that as a balance is wrong by whatever was already banked.
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
   * Energy the array produced on days the meter recorded no export. Not part of the
   * balance — the utility did not count it — but carried so a lower-than-expected figure
   * has its explanation attached.
   */
  neverCreditedKwh: number;
  basis: DerivationBasis;
  summary: string;
}

const round = (value: number): number => Math.round(value * 10) / 10;

const dayCount = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);

/**
 * Fold the meter days into a bank balance. Day by day rather than one net sum, because the
 * bank cannot go negative: netting the whole period would carry forward an overdraft that
 * never existed. `emptied` distinguishes a bank drained to zero from one never filled.
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
    Gaps bias the result upward rather than randomly: missing days are almost always
    high-consumption ones with no export.
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
      // The bank ran out and the rest was bought. It does not go negative.
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
