/**
 * Energy for devices that cannot measure it: a switch-only plug reports a relay state and
 * nothing more, so energy is on-time times an owner-declared wattage.
 *
 * Only good for SOME loads. A baseboard heater draws its rated wattage whenever the relay
 * is closed; a variable-speed pump or inverter heat pump modulates over a range of several
 * to one, where on-time x rated is an upper bound. So the owner declares the KIND of load
 * too, and every figure carries the confidence that kind earns.
 */

export type LoadType =
  /** Heaters, kettles, incandescent bulbs. Constant draw whenever it is on. */
  | 'resistive'
  /** Single-speed motors — pool pumps, fans, fridge compressors. Near-constant. */
  | 'motor'
  /** Variable-speed or inverter-driven. Modulates over a wide range. */
  | 'variable'
  /** Electronics — TVs, computers, chargers. Draw depends on what it is doing. */
  | 'electronic';

export interface LoadConfig {
  /** Nameplate or measured wattage while running. */
  ratedW?: number;
  /** What it feeds, in the owner's words: "Pool pump", "Garage freezer". */
  loadLabel?: string;
  loadType?: LoadType;
}

export type Confidence = 'good' | 'fair' | 'rough';

interface Profile {
  confidence: Confidence;
  /** Shown next to the figure. Written to be read by whoever has to trust it. */
  note: string;
}

/**
 * How far to trust on-time x rated watts, per load type. Not tuning knobs: nothing here
 * scales the number, only what the app SAYS about it.
 */
const PROFILES: Record<LoadType, Profile> = {
  resistive: {
    confidence: 'good',
    note: 'A resistive load draws its rated wattage whenever it is on, so this is close to measured.',
  },
  motor: {
    confidence: 'good',
    note: 'A single-speed motor draws close to its rated wattage while running.',
  },
  variable: {
    confidence: 'rough',
    note: 'Variable-speed and inverter-driven equipment modulates over a wide range, so this is closer to a ceiling than an estimate. Metering the circuit is the only way to know.',
  },
  electronic: {
    confidence: 'fair',
    note: 'Electronics draw varies with what they are doing, so treat this as indicative.',
  },
};

/** Load type when the owner has not said. Deliberately the least flattering one. */
const UNDECLARED: Profile = {
  confidence: 'rough',
  note: 'No load type set, so this assumes a constant draw. Say what it feeds to get a better figure.',
};

export interface LoadEstimate {
  energyWh: number;
  confidence: Confidence;
  note: string;
  label?: string;
}

/**
 * Estimate energy from time-on and a declared wattage. Null rather than zero when there is
 * nothing to go on: 0.0 kWh would assert an unmetered device used nothing.
 */
export function estimateFromOnTime(onHours: number, config: LoadConfig): LoadEstimate | null {
  const { ratedW, loadType, loadLabel } = config;
  if (!ratedW || !(ratedW > 0) || !Number.isFinite(ratedW)) return null;
  if (!Number.isFinite(onHours) || onHours < 0) return null;
  const profile = loadType ? PROFILES[loadType] : UNDECLARED;
  return {
    energyWh: onHours * ratedW,
    confidence: profile.confidence,
    note: profile.note,
    label: loadLabel,
  };
}

/** Parse the load settings out of a device's config JSON, ignoring anything invalid. */
export function readLoadConfig(configJson: string | null): LoadConfig {
  if (!configJson) return {};
  try {
    const parsed = JSON.parse(configJson) as Record<string, unknown>;
    const ratedW = typeof parsed.ratedW === 'number' && parsed.ratedW > 0 ? parsed.ratedW : undefined;
    const loadLabel = typeof parsed.loadLabel === 'string' && parsed.loadLabel.trim()
      ? parsed.loadLabel.trim()
      : undefined;
    const loadType =
      typeof parsed.loadType === 'string' && parsed.loadType in PROFILES
        ? (parsed.loadType as LoadType)
        : undefined;
    return { ratedW, loadLabel, loadType };
  } catch {
    return {};
  }
}

export const LOAD_TYPES = Object.keys(PROFILES) as LoadType[];

export interface DailyEnergySample {
  localDate: string;
  energyTodayWh: number | null;
}

/**
 * Total energy across a window, from a counter that resets each day — Daikin reports
 * energy-so-far-today rather than a lifetime figure.
 *
 * The sum of each day's MAX: the last reading of a day is wrong the moment a poll lands
 * just after midnight, and summing every reading multiplies by the polling rate. Within a
 * day the figure only climbs, so the peak is the day's total however the samples fall.
 */
export function sumDailyMaxima(samples: DailyEnergySample[]): number | null {
  const byDate = new Map<string, number>();
  for (const sample of samples) {
    const value = sample.energyTodayWh;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    byDate.set(sample.localDate, Math.max(byDate.get(sample.localDate) ?? 0, value));
  }
  if (byDate.size === 0) return null;
  let total = 0;
  for (const value of byDate.values()) total += value;
  return total;
}
