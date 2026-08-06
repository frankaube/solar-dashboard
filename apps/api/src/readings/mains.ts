/**
 * Self-consumption, measured at the mains instead of guessed.
 *
 * Everything else in this app can only see solar it can name. A charge session, a battery
 * discharge — those are measurable because a device reported them. The fridge, the heat
 * pumps and the water heater are invisible, so measured self-consumption reads far too low
 * and nearly every kWh gets valued at the export rate. The gap is papered over with a
 * percentage the owner types in, applied as a floor, and every figure downstream carries
 * "estimated" as a result.
 *
 * A clamp on the service entrance closes it, and does so by subtraction rather than by
 * addition: what the house used directly is what the array made minus what actually left
 * the property. No appliance has to be identified, metered or even known about.
 *
 *     selfConsumed = produced − exported
 *
 * `exported` is the integral of the negative half of mains power. The sign is the whole
 * measurement — a meter reading −4,000 W is selling four kilowatts, and one reading
 * +4,000 W is buying them, and any code that takes an absolute value here has thrown away
 * the only thing being measured. `DeviceReading.powerW` is documented signed for exactly
 * this reason.
 */

const MS_PER_HOUR = 3_600_000;

/**
 * Longest gap between samples that still counts as continuous.
 *
 * The same ten minutes the savings engine already uses. A meter that drops off the network
 * for an hour must not have that hour credited at whatever it happened to be reading when
 * it left; the alternative is a large invented number, arriving quietly at the moment the
 * data is worst.
 */
export const MAX_SAMPLE_GAP_MS = 10 * 60_000;

export interface MainsSample {
  takenAt: Date;
  /** Signed: positive is drawn from the grid, negative is sent back to it. */
  powerW: number;
}

export interface MainsTotals {
  importedWh: number;
  exportedWh: number;
}

/**
 * Integrate signed mains power into imported and exported watt-hours, per local date.
 *
 * Trapezoid over each pair of consecutive samples, but only where the pair spans a real
 * interval and the two lie on the same side of zero. A pair straddling zero is split at
 * the crossing rather than assigned whole to either side: over a five-minute sample gap on
 * a spring afternoon the house crosses from exporting to importing constantly, and
 * dumping each such interval into one bucket biases both totals by whichever way the
 * rounding happened to fall.
 *
 * Attribution is by the *earlier* sample's date, so an interval spanning midnight belongs
 * to the day it started. Splitting it would be more precise and would disagree with how
 * production is bucketed, and two totals that disagree about where a day ends is a worse
 * failure than a few watt-hours on the wrong side of midnight.
 */
export function integrateMains(
  samples: MainsSample[],
  localDateOf: (date: Date) => string,
): Map<string, MainsTotals> {
  const byDate = new Map<string, MainsTotals>();
  const add = (date: string, imported: number, exported: number): void => {
    const totals = byDate.get(date) ?? { importedWh: 0, exportedWh: 0 };
    totals.importedWh += imported;
    totals.exportedWh += exported;
    byDate.set(date, totals);
  };

  const ordered = [...samples].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    const spanMs = current.takenAt.getTime() - previous.takenAt.getTime();
    if (spanMs <= 0 || spanMs > MAX_SAMPLE_GAP_MS) continue;
    if (!Number.isFinite(previous.powerW) || !Number.isFinite(current.powerW)) continue;

    const date = localDateOf(previous.takenAt);
    const hours = spanMs / MS_PER_HOUR;
    const a = previous.powerW;
    const b = current.powerW;

    if (a >= 0 && b >= 0) {
      add(date, ((a + b) / 2) * hours, 0);
    } else if (a <= 0 && b <= 0) {
      add(date, 0, ((-a + -b) / 2) * hours);
    } else {
      /*
        Straddles zero. Split at the crossing: each side is a triangle whose base is the
        fraction of the interval spent on that side.
      */
      const crossing = Math.abs(a) / (Math.abs(a) + Math.abs(b));
      const firstHours = hours * crossing;
      const secondHours = hours - firstHours;
      const firstArea = (Math.abs(a) / 2) * firstHours;
      const secondArea = (Math.abs(b) / 2) * secondHours;
      if (a > 0) add(date, firstArea, secondArea);
      else add(date, secondArea, firstArea);
    }
  }
  return byDate;
}

/**
 * Solar used on site, from production and what left the property.
 *
 * Clamped into [0, produced]. Outside that range the inputs disagree — a meter reading a
 * circuit that is not the whole service, a production figure covering a window the meter
 * was offline for — and the honest response to contradictory inputs is the nearest
 * possible answer, not a negative quantity of electricity or one exceeding what was made.
 */
export function selfConsumedFromMains(producedWh: number, exportedWh: number): number {
  if (!Number.isFinite(producedWh) || producedWh <= 0) return 0;
  if (!Number.isFinite(exportedWh) || exportedWh < 0) return 0;
  return Math.max(0, Math.min(producedWh, producedWh - exportedWh));
}
