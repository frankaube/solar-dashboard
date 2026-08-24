import { localDateOf } from '../common/localdate';

/**
 * Folding five-minute readings into hours, and deciding what may then be thrown away.
 *
 * The arithmetic is here and the database work is in the service, because the parts worth
 * getting right are the parts a test can hold still: which hour a reading belongs to, what
 * an hour's energy actually is, and which rows must survive a purge no matter how old.
 */

export const HOUR_MS = 3_600_000;

/** The hour a reading falls in, as an instant. UTC hours: an hour is an hour in any zone. */
export function hourStartOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

export interface RawSample {
  takenAt: Date;
  powerW: number;
  /** The device's own cumulative counter, whatever it counts. */
  counter: number;
  /** True where the row came from a vendor export rather than a poll. */
  imported?: boolean;
}

export interface HourBucket {
  hourStart: Date;
  localDate: string;
  avgPowerW: number;
  maxPowerW: number;
  energyWh: number;
  lastCounter: number;
  samples: number;
  imported: number;
}

/**
 * Group readings into hours.
 *
 * ENERGY IS THE COUNTER'S RISE ACROSS THE HOUR, not an integral of the power curve. The
 * counter lives on the gateway and survives anything this app failed to see, while
 * integrating five-minute samples silently under-reports every gap. That choice is already
 * made everywhere else in this app and must not be re-decided here, or a day's total would
 * depend on whether it had been rolled up yet.
 *
 * A counter that goes backwards is a reset — midnight, or a device replaced — and contributes
 * nothing rather than a negative. Reading a reset as production would hand a panel a lifetime
 * of energy in one hour.
 */
export function bucketByHour(
  samples: RawSample[],
  timeZone?: string,
  previousCounter?: number,
): HourBucket[] {
  const ordered = [...samples].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const byHour = new Map<number, RawSample[]>();
  for (const sample of ordered) {
    const key = hourStartOf(sample.takenAt).getTime();
    const list = byHour.get(key);
    if (list) list.push(sample);
    else byHour.set(key, [sample]);
  }

  /*
    The counter as it stood before this batch, so the first hour's energy is its rise from
    the end of the previous hour rather than from its own first sample. Without it every
    hour would lose whatever was produced between the last reading of one hour and the first
    of the next — five minutes an hour, which is 2% of a day quietly gone.
  */
  /*
    The running HIGH-WATER MARK, not the last value.

    These counters wind down. The gateway's own daily figure falls back as the array settles
    in the evening, which is why every other rollup in this app takes a day's production as
    `MAX(dailyEnergy)` rather than the newest reading. Measuring each hour from the previous
    hour's last sample loses whatever the counter reached mid-hour and then gave back: on this
    array's real history that was between 4 and 160 Wh a day, always short, on thirteen days
    out of twenty-two.

    Tracking the peak instead makes the hours sum to exactly the day's maximum, which is the
    same number the rest of the app calls the day's total.
  */
  let peak = previousCounter;
  const out: HourBucket[] = [];
  for (const key of [...byHour.keys()].sort((a, b) => a - b)) {
    const rows = byHour.get(key) as RawSample[];
    const powers = rows.map((row) => row.powerW);
    const counters = rows.map((row) => row.counter);
    const hourPeak = Math.max(...counters);
    const from = peak ?? counters[0];
    const rise = hourPeak - from;
    out.push({
      hourStart: new Date(key),
      localDate: localDateOf(new Date(key), timeZone),
      avgPowerW: powers.reduce((sum, w) => sum + w, 0) / powers.length,
      maxPowerW: Math.max(...powers),
      energyWh: rise > 0 ? Math.round(rise) : 0,
      lastCounter: rows[rows.length - 1].counter,
      samples: rows.length,
      imported: rows.filter((row) => row.imported).length,
    });
    peak = Math.max(from, hourPeak);
  }
  return out;
}

/**
 * Does an hour's rollup faithfully account for the rows it was built from?
 *
 * NOTHING IS EVER DELETED ON THE STRENGTH OF A UNIT TEST. The rollup exists so that raw rows
 * can one day be dropped, and the only honest way to earn that is to run both side by side on
 * real data and prove they agree — for months, across resets, gaps, imports and daylight
 * saving, on this array and on somebody else's.
 *
 * So this compares what the hourly rows say a day produced against what the raw rows say, and
 * it is reported rather than acted on. A purge may be written when this has been quiet for a
 * long time, and it will need two guards that do not exist yet: it must refuse any hour it
 * has not verified, and it must never drop the newest reading of a panel however old, because
 * lifetime energy is the sum of exactly those rows and a retired panel would otherwise take
 * its production with it.
 */
export function reconcile(
  rawEnergyWh: number,
  rolledEnergyWh: number,
  toleranceWh = 1,
): { agrees: boolean; differenceWh: number } {
  const differenceWh = rolledEnergyWh - rawEnergyWh;
  return { agrees: Math.abs(differenceWh) <= toleranceWh, differenceWh };
}
