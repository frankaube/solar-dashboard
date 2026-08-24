/**
 * How much of a charge came off the roof.
 *
 * The share is the integral of min(what the car was drawing, what the array was making)
 * over the charge — not "was the sun up", and not the day's totals. Drawing 11 kW while
 * the roof makes 3 kW is 3 kW of sunshine and 8 kW of grid, in the same minute.
 *
 * Extracted from the Wall Connector path so a second source can use it. The Wall Connector
 * stopped answering on 28 July and every charge since lost its solar figure — but the car
 * itself records the same thing, at better resolution (a hundred-odd samples per charge),
 * and most installs have no Wall Connector at all. One implementation, either input.
 */

export interface PowerSample {
  /** Epoch milliseconds. */
  t: number;
  /** Watts. */
  w: number;
}

/**
 * A production sample this far from the moment being asked about is not evidence about it.
 * The array reports every five minutes; beyond twice that, treat it as unknown, which
 * scores as no sun rather than as stale sun.
 */
const SOLAR_PAIRING_WINDOW_MS = 10 * 60_000;

/**
 * A gap longer than this is missing data, not a long steady draw.
 *
 * Without the cap, a logger that dropped out for six hours mid-charge would have its last
 * sample before the gap integrated across the whole of it — inventing kilowatt-hours of
 * sunshine out of an outage.
 */
const MAX_SAMPLE_GAP_MS = 2 * 60_000;

export interface SolarShare {
  solarWh: number;
  solarPct: number;
}

/**
 * @param draw    What the car was drawing, in time order.
 * @param solar   What the array was making, in time order.
 * @param energyWh Total energy of the charge, when a meter knows it better than the
 *                 integral does. The result is capped at it: a solar share above the
 *                 energy actually delivered is arithmetic that escaped its own premise.
 */
export function solarShareOf(
  draw: PowerSample[],
  solar: PowerSample[],
  energyWh?: number,
): SolarShare {
  if (draw.length < 2) return { solarWh: 0, solarPct: 0 };

  let cursor = 0;
  const solarAt = (t: number): number => {
    while (cursor + 1 < solar.length && solar[cursor + 1].t <= t) cursor++;
    const sample = solar[cursor];
    if (!sample || Math.abs(sample.t - t) > SOLAR_PAIRING_WINDOW_MS) return 0;
    return sample.w;
  };

  let solarWh = 0;
  let drawnWh = 0;
  for (let i = 0; i < draw.length - 1; i++) {
    const dtHours = Math.min(draw[i + 1].t - draw[i].t, MAX_SAMPLE_GAP_MS) / 3_600_000;
    if (dtHours <= 0) continue;
    solarWh += Math.min(draw[i].w, solarAt(draw[i].t)) * dtHours;
    drawnWh += draw[i].w * dtHours;
  }

  // Prefer the meter's total where there is one; fall back to the integral of the draw.
  const total = energyWh !== undefined && energyWh > 0 ? energyWh : drawnWh;
  const capped = Math.min(solarWh, total);
  return {
    solarWh: Math.round(capped),
    solarPct: total > 0 ? Math.round((capped / total) * 100) : 0,
  };
}
