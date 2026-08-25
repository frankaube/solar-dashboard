/**
 * Self-consumption, measured at the mains instead of guessed.
 *
 * Elsewhere the app only sees solar it can name — a charge session, a battery discharge —
 * so measured self-consumption reads far too low and is floored with a typed percentage. A
 * clamp on the service entrance closes the gap by subtraction, identifying no appliance:
 *
 *     selfConsumed = produced − exported
 *
 * `exported` is the integral of the negative half of mains power. THE SIGN IS THE
 * MEASUREMENT: −4,000 W is selling four kilowatts, +4,000 W is buying them, and an absolute
 * value here discards it. `DeviceReading.powerW` is documented signed for this reason.
 */

const MS_PER_HOUR = 3_600_000;

/**
 * Longest gap between samples that still counts as continuous — the same ten minutes the
 * savings engine uses. A meter off the network for an hour must not have that hour credited
 * at whatever it was last reading.
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
 * Trapezoid over each consecutive pair. A pair straddling zero is split at the crossing
 * rather than assigned whole to either side: over a five-minute gap the house crosses
 * between export and import constantly, and bucketing whole intervals biases both totals.
 *
 * Attribution is by the EARLIER sample's date, so an interval spanning midnight belongs to
 * the day it started — matching how production is bucketed. Splitting it would be more
 * precise but would put the two totals in disagreement about where a day ends.
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
 * Solar used on site, from production and what left the property. Clamped into [0, produced]:
 * outside that the inputs disagree — a meter on less than the whole service, or a production
 * figure covering a window the meter was offline for.
 */
export function selfConsumedFromMains(producedWh: number, exportedWh: number): number {
  if (!Number.isFinite(producedWh) || producedWh <= 0) return 0;
  if (!Number.isFinite(exportedWh) || exportedWh < 0) return 0;
  return Math.max(0, Math.min(producedWh, producedWh - exportedWh));
}
