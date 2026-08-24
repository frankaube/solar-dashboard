/*
  Clipping: the inverter refusing to pass more AC while the panels keep making DC.

  Every microinverter has an AC output rating below what its panels can produce on the very
  best days, and that is deliberate design — a DC:AC ratio above 1.0 buys more output across
  every ordinary hour in exchange for shaving a handful of peak ones. The question is only
  whether it is happening, and how much it costs.

  WHAT DOES NOT WORK, and looks like it should: a histogram of output. Power piles up near
  the daily maximum on any clear day, because output near solar noon is flat and a curve
  spends most of its time where its slope is smallest. A perfectly unclipped array produces
  a dramatic spike in the top bucket. Reading that as a ceiling is the obvious mistake and
  this file exists partly to not make it.

  WHAT WORKS: conversion efficiency against DC input. A microinverter turns DC into AC at a
  near-constant rate — measured on this array at 94.81% across every band from 600 W to
  1500 W, stable to two decimal places over thirteen thousand samples. Clipping breaks that
  line and only that line: DC climbs, AC stops, so the ratio falls off a cliff in the top
  band while every band below it is untouched.

  So the test is a shape, not a threshold: flat efficiency everywhere, a drop at the top.
*/

/** One paired reading: what the panels delivered, and what came out the other side. */
export interface ClipSample {
  /** Epoch milliseconds. */
  at: number;
  /** Sum of this inverter's port power, in watts. */
  dcW: number;
  /** The inverter's AC output at the same instant, in watts. */
  acW: number;
}

export interface ClipFinding {
  /** Where AC stopped rising, in watts — the effective ceiling. */
  ceilingAcW: number;
  /** The conversion rate everywhere below the ceiling, 0-1. */
  plateauEfficiency: number;
  /** The conversion rate in the top DC band, 0-1. Below the plateau is the whole finding. */
  topEfficiency: number;
  /** How many samples were taken with the unit against its ceiling. */
  clippedSamples: number;
  /** Watt-hours per day lost to the ceiling, integrated over real sample gaps. */
  lostWhPerDay: number;
  /** Epoch ms of the earliest clipped sample. */
  firstAt: number;
  /** Epoch ms of the most recent clipped sample. */
  lastAt: number;
}

/*
  Bands are a share of the unit's OWN peak, never absolute watts.

  A one-panel microinverter and a four-panel one differ by a factor of four, and this array
  has both. Normalising by each unit's own maximum lets one set of numbers describe both,
  and keeps working if a panel is ever added or moved.
*/
const BAND_COUNT = 10;
/** The plateau is read from the middle of the range, well clear of both ends. */
const PLATEAU_FROM_BAND = 4; // 40% of peak DC
const PLATEAU_TO_BAND = 7; //   80% of peak DC
/** The top band, where a ceiling shows up. */
const TOP_BAND = BAND_COUNT - 1;

/**
 * How far efficiency must fall before this is called clipping.
 *
 * The plateau measured here holds to within 0.01 points across the whole range, so almost
 * any drop is real. Two full points is far outside that and still small enough to catch a
 * ceiling on the first day it is touched. Set generously on purpose: a false "you are
 * clipping" would send someone to argue with their installer about hardware that is fine.
 */
const EFFICIENCY_DROP = 0.02;

/** Below this the unit is barely awake and the ratio is noise. */
const MIN_DC_W = 25;
/** A band with fewer samples than this cannot support a conclusion. */
const MIN_BAND_SAMPLES = 20;
/**
 * Longest gap credited to a sample when integrating lost energy.
 *
 * Readings are stored on change or on a heartbeat, so a quiet stretch can leave a gap of
 * hours. Crediting one clipped sample with three hours of loss because the next row is far
 * away would invent most of the answer.
 */
const MAX_GAP_MS = 10 * 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Look for a ceiling in one inverter's history.
 *
 * Returns null for anything that is not clipping, which is the overwhelmingly common answer
 * and should stay cheap to say.
 */
export function detectClipping(samples: ClipSample[]): ClipFinding | null {
  const usable = samples.filter((s) => s.dcW >= MIN_DC_W && s.acW > 0 && s.at > 0);
  if (usable.length < MIN_BAND_SAMPLES * 3) return null;

  const peakDc = Math.max(...usable.map((s) => s.dcW));
  if (peakDc < MIN_DC_W) return null;

  /*
    Bucket by DC share of peak. The top band is half-open at the top so the single peak
    sample lands in it rather than in a band of its own.
  */
  const bands: number[][] = Array.from({ length: BAND_COUNT }, () => []);
  const inBand: ClipSample[][] = Array.from({ length: BAND_COUNT }, () => []);
  for (const s of usable) {
    const band = Math.min(BAND_COUNT - 1, Math.floor((s.dcW / peakDc) * BAND_COUNT));
    bands[band].push(s.acW / s.dcW);
    inBand[band].push(s);
  }

  const plateauRatios: number[] = [];
  for (let b = PLATEAU_FROM_BAND; b <= PLATEAU_TO_BAND; b++) {
    if (bands[b].length >= MIN_BAND_SAMPLES) plateauRatios.push(...bands[b]);
  }
  // No usable mid-range means no baseline to judge the top against. Say nothing.
  if (plateauRatios.length < MIN_BAND_SAMPLES) return null;
  if (bands[TOP_BAND].length < MIN_BAND_SAMPLES) return null;

  const plateauEfficiency = median(plateauRatios);
  const topEfficiency = median(bands[TOP_BAND]);
  if (topEfficiency >= plateauEfficiency - EFFICIENCY_DROP) return null;

  /*
    The ceiling is the highest AC actually seen, not the top band's average.

    A clipped unit sits AT its limit rather than near it, so the maximum is the limit — and
    it is the number worth showing, because it is the one that can be compared against the
    nameplate on the label.
  */
  const clipped = inBand[TOP_BAND];
  const ceilingAcW = Math.max(...clipped.map((s) => s.acW));

  /*
    Lost energy, integrated over real gaps rather than assumed intervals.

    Each clipped sample is credited with the time until the next sample anywhere in the
    series, capped. What was lost is what the plateau would have delivered from the DC that
    was actually available, less what came out.
  */
  const ordered = [...usable].sort((a, b) => a.at - b.at);
  const nextAt = new Map<number, number>();
  for (let i = 0; i < ordered.length - 1; i++) nextAt.set(ordered[i].at, ordered[i + 1].at);

  let lostWh = 0;
  for (const s of clipped) {
    const deficitW = s.dcW * plateauEfficiency - s.acW;
    if (deficitW <= 0) continue;
    const gap = Math.min(MAX_GAP_MS, Math.max(0, (nextAt.get(s.at) ?? s.at) - s.at));
    lostWh += (deficitW * gap) / MS_PER_HOUR;
  }

  const times = clipped.map((s) => s.at);
  const spanMs = ordered[ordered.length - 1].at - ordered[0].at;
  // Per day over the WHOLE window, not over the clipped days — clipping is seasonal and
  // averaging only across the days it happened would overstate the yearly cost.
  const days = Math.max(1, spanMs / MS_PER_DAY);

  return {
    ceilingAcW: Math.round(ceilingAcW * 10) / 10,
    plateauEfficiency,
    topEfficiency,
    clippedSamples: clipped.length,
    lostWhPerDay: Math.round((lostWh / days) * 10) / 10,
    firstAt: Math.min(...times),
    lastAt: Math.max(...times),
  };
}
