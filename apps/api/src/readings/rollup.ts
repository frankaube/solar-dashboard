import { localDateOf } from '../common/localdate';

/**
 * Folding five-minute readings into hours. Arithmetic here, database work in the service.
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
 * ENERGY IS THE COUNTER'S RISE ACROSS THE HOUR, not an integral of the power curve: the
 * counter lives on the gateway and survives collection gaps, which integration does not.
 * Must match the choice made elsewhere, or a day's total would depend on whether it had
 * been rolled up. A counter going backwards is a reset and contributes zero, not a negative.
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
    Seeded with the counter before this batch, so an hour's energy is its rise from the end
    of the previous hour rather than from its own first sample. A running HIGH-WATER MARK,
    not the last value: these counters wind down in the evening, which is why rollups
    elsewhere use MAX(dailyEnergy). Measuring from the previous hour's last sample lost
    4-160 Wh a day on real history; the peak makes the hours sum to the day's maximum.
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
 * Reported, never acted on: nothing is deleted on the strength of this. Any future purge
 * needs two guards that do not exist yet — it must refuse any hour it has not verified, and
 * it must never drop the newest reading of a panel however old, because lifetime energy is
 * the sum of exactly those rows and a retired panel would take its production with it.
 */
export function reconcile(
  rawEnergyWh: number,
  rolledEnergyWh: number,
  toleranceWh = 1,
): { agrees: boolean; differenceWh: number } {
  const differenceWh = rolledEnergyWh - rawEnergyWh;
  return { agrees: Math.abs(differenceWh) <= toleranceWh, differenceWh };
}
