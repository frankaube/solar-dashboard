/**
 * Daily production totalled by day, month or year — for comparing one period against
 * another.
 *
 * The whole difficulty is that most periods are not whole. This array started reporting on
 * 23 July, so July holds nine days and August holds however many have elapsed; drawn as
 * plain bars they say "production collapsed in August", which is false and is the first
 * thing anyone would read off them. Every bucket therefore carries how many days it
 * actually has against how many the calendar says, and whether the period has ended.
 *
 * The alternative — hiding partial periods — is worse: it silently drops the month you are
 * living in, which is the one you most want to see.
 */

export interface DailyTotal {
  /** Local date, YYYY-MM-DD. */
  date: string;
  energyWh: number;
}

export type Grouping = 'day' | 'month' | 'year';

export interface ProductionBucket {
  /** Sort/identity key: '2026-08-03', '2026-08' or '2026'. */
  key: string;
  label: string;
  energyWh: number;
  /** Days in this bucket we have a reading for. */
  daysWithData: number;
  /** Days the calendar says the period has. */
  daysInPeriod: number;
  /**
   * A whole period, fully observed. False for the period in progress and for any period we
   * only partly recorded — a bar that is not `complete` cannot be compared with one that
   * is, and the chart draws it differently.
   */
  complete: boolean;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const isLeap = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number =>
  [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

function keyOf(date: string, grouping: Grouping): string {
  if (grouping === 'year') return date.slice(0, 4);
  if (grouping === 'month') return date.slice(0, 7);
  return date;
}

function labelOf(key: string, grouping: Grouping): string {
  if (grouping === 'year') return key;
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  /*
    The full year, not two digits. "Jul 26" is indistinguishable from the day label for
    26 July — the two groupings would produce identical strings meaning different things,
    on a chart whose entire purpose is comparing periods.
  */
  if (grouping === 'month') return `${MONTH_NAMES[month - 1]} ${year}`;
  return `${MONTH_NAMES[month - 1]} ${Number(key.slice(8, 10))}`;
}

function periodLength(key: string, grouping: Grouping): number {
  if (grouping === 'day') return 1;
  const year = Number(key.slice(0, 4));
  if (grouping === 'year') return isLeap(year) ? 366 : 365;
  return daysInMonth(year, Number(key.slice(5, 7)));
}

/**
 * Group daily totals.
 *
 * `today` is the local date string, passed in rather than read from the clock so this
 * stays a pure function — and so a test can sit on the last day of a month without waiting
 * for one.
 */
export function bucketProduction(
  daily: DailyTotal[],
  grouping: Grouping,
  today: string,
): ProductionBucket[] {
  const totals = new Map<string, { energyWh: number; days: Set<string> }>();
  for (const row of daily) {
    // A malformed date would otherwise become its own bucket labelled "NaN".
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    const key = keyOf(row.date, grouping);
    const entry = totals.get(key) ?? { energyWh: 0, days: new Set<string>() };
    entry.energyWh += row.energyWh;
    entry.days.add(row.date);
    totals.set(key, entry);
  }

  const currentKey = keyOf(today, grouping);
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => {
      const daysInPeriod = periodLength(key, grouping);
      const daysWithData = entry.days.size;
      /*
        The period in progress is never complete, even when every elapsed day is recorded:
        today is still accumulating, and so is this month. Keys sort lexicographically for
        all three groupings, so a key after the current one — a clock skew, a bad row — is
        also not something to call finished.
      */
      const ended = key < currentKey;
      return {
        key,
        label: labelOf(key, grouping),
        energyWh: Math.round(entry.energyWh),
        daysWithData,
        daysInPeriod,
        complete: ended && daysWithData === daysInPeriod,
      };
    });
}

/**
 * What to say above the chart.
 *
 * Named separately because the honest sentence depends on how many *complete* buckets
 * there are, and that is the number the reader needs before drawing any conclusion. With
 * one array's worth of history, "months" means two partial bars — a comparison that does
 * not exist yet, and the chart should say so rather than let the shapes imply one.
 */
export function describeBuckets(buckets: ProductionBucket[], grouping: Grouping): string {
  const noun = grouping === 'day' ? 'day' : grouping === 'month' ? 'month' : 'year';
  const complete = buckets.filter((b) => b.complete).length;
  if (buckets.length === 0) return 'Nothing recorded yet.';
  if (complete === 0) {
    return buckets.length === 1
      ? `One ${noun} so far, still in progress — nothing to compare it against yet.`
      : `No complete ${noun}s yet — every bar here is a part-period.`;
  }
  if (complete === 1) {
    return `One complete ${noun}, and ${buckets.length - 1} part-period${buckets.length - 1 === 1 ? '' : 's'} shown lighter.`;
  }
  const partial = buckets.length - complete;
  return partial === 0
    ? `${complete} complete ${noun}s.`
    : `${complete} complete ${noun}s; ${partial} part-period${partial === 1 ? '' : 's'} shown lighter.`;
}
