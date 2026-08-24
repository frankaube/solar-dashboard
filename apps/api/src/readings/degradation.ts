/**
 * Panel degradation, from this array's own learned response.
 *
 * `wattsPerIrradiance` — watts of AC output per W/m² of irradiance — is already computed
 * for the expected-vs-actual chart, and it is exactly the quantity that decays as panels
 * age. Weather cancels out of it by construction: it is a ratio against measured sunlight,
 * not against the calendar. Snapshot it once a month and its slope over years is the
 * degradation rate, measured on this roof rather than read off a warranty.
 *
 * The catch is that it takes years, and that is the whole design problem here.
 *
 * A month of data can be fitted to a line, and that line will have a slope, and the slope
 * will be enormous and meaningless — seasonal sun angle alone moves the ratio far more
 * than ageing does over any short window. Reporting it would produce "your panels are
 * degrading 40% per year" from noise, in the same typeface as a real figure. So this
 * refuses: no rate at all until the record spans long enough for one, and until then it
 * says how much longer rather than guessing.
 *
 * That refusal is why the snapshot must start now. The rate cannot be backfilled — nobody
 * stores irradiance-paired output from before they thought to. Every month not recorded is
 * a month permanently missing from a measurement that only gets more valuable with age.
 */

/** One month's learned response, as stored. */
export interface ResponseSnapshot {
  /** YYYY-MM, local. */
  month: string;
  wattsPerIrradiance: number;
  /** Paired output/irradiance samples the median was taken over. */
  samples: number;
}

/**
 * Months of record before a slope is worth stating.
 *
 * Two full years. One year cannot separate ageing from the seasonal cycle at all — the
 * fit would just be measuring where in the year the record happens to start and end. Two
 * gives a whole cycle at each end, which is the minimum that makes the difference between
 * them attributable to something other than the calendar.
 */
export const MONTHS_FOR_A_RATE = 24;

/** Below this, a month's median is drawn from too little sun to trust. */
export const MIN_SAMPLES = 200;

export interface DegradationDto {
  snapshots: ResponseSnapshot[];
  monthsRecorded: number;
  monthsNeeded: number;
  /** Percent change per year. Null until the record is long enough to mean anything. */
  annualChangePct: number | null;
  /** What can honestly be said right now. */
  summary: string;
}

/** Whole months between two YYYY-MM keys. */
function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * Least-squares slope of response against month index, as a percentage of the fitted
 * starting value per year.
 *
 * Expressed against the fit's own intercept rather than the first observed month, so one
 * unusually cloudy or unusually clear first month cannot set the denominator for the whole
 * result.
 */
function annualChange(points: Array<{ x: number; y: number }>): number | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.x - meanX) * (p.y - meanY);
    sxx += (p.x - meanX) ** 2;
  }
  if (sxx === 0) return null;
  const slopePerMonth = sxy / sxx;
  const intercept = meanY - slopePerMonth * meanX;
  if (!Number.isFinite(intercept) || intercept <= 0) return null;
  return ((slopePerMonth * 12) / intercept) * 100;
}

/**
 * What the record supports saying.
 *
 * Snapshots with too few samples are dropped rather than down-weighted — a median over a
 * handful of dim readings is not a weak measurement of the array's response, it is a
 * measurement of something else.
 */
export function assessDegradation(snapshots: ResponseSnapshot[]): DegradationDto {
  const usable = [...snapshots]
    .filter((s) => s.samples >= MIN_SAMPLES && Number.isFinite(s.wattsPerIrradiance) && s.wattsPerIrradiance > 0)
    .sort((a, b) => a.month.localeCompare(b.month));

  if (usable.length === 0) {
    return {
      snapshots: usable,
      monthsRecorded: 0,
      monthsNeeded: MONTHS_FOR_A_RATE,
      annualChangePct: null,
      summary:
        'No month has recorded enough paired output and irradiance yet. This begins once the array has seen a full month of sun.',
    };
  }

  const span = monthsBetween(usable[0].month, usable[usable.length - 1].month) + 1;
  const remaining = Math.max(0, MONTHS_FOR_A_RATE - span);

  if (span < MONTHS_FOR_A_RATE) {
    return {
      snapshots: usable,
      monthsRecorded: span,
      monthsNeeded: MONTHS_FOR_A_RATE,
      annualChangePct: null,
      summary:
        `${span} month${span === 1 ? '' : 's'} of record. A degradation rate needs about ${MONTHS_FOR_A_RATE} — ` +
        `roughly ${remaining} more — because over anything shorter the seasonal sun angle moves this figure far ` +
        'more than ageing does, and a slope fitted now would be measuring the calendar.',
    };
  }

  const rate = annualChange(usable.map((s, index) => ({ x: index, y: s.wattsPerIrradiance })));
  if (rate === null) {
    return {
      snapshots: usable,
      monthsRecorded: span,
      monthsNeeded: MONTHS_FOR_A_RATE,
      annualChangePct: null,
      summary: `${span} months of record, but the values do not support a fit.`,
    };
  }

  const rounded = Math.round(rate * 100) / 100;
  const direction =
    rounded < -0.1
      ? `losing about ${Math.abs(rounded).toFixed(2)}% of its output per year`
      : rounded > 0.1
        ? `measuring ${rounded.toFixed(2)}% per year higher, which is not something panels do — suspect cleaning, ` +
          'a repair, or a change in what the weather source reports rather than an improving array'
        : 'showing no measurable change';
  return {
    snapshots: usable,
    monthsRecorded: span,
    monthsNeeded: MONTHS_FOR_A_RATE,
    annualChangePct: rounded,
    summary: `Over ${span} months of record, this array is ${direction}.`,
  };
}
