/*
  Clipping: the inverter refusing to pass more AC while the panels keep making DC. A DC:AC
  ratio above 1.0 is deliberate design, so the question is only whether it happens and what
  it costs.

  DOES NOT WORK: a histogram of output. The curve is flat near solar noon, so power piles up
  near the daily maximum and even a perfectly unclipped array spikes in the top bucket.

  WORKS: conversion efficiency against DC input, which is near-constant — measured on this
  array at 94.81% from 600 W to 1500 W, stable to two decimals over 13,000 samples. Clipping
  breaks that line and only that line, so the test is a shape rather than a threshold: flat
  efficiency everywhere, a drop in the top band.
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
  Bands are a share of the unit's OWN peak, never absolute watts: a one-panel microinverter
  and a four-panel one differ by a factor of four, and this array has both.
*/
const BAND_COUNT = 10;
/** The plateau is read from the middle of the range, well clear of both ends. */
const PLATEAU_FROM_BAND = 4; // 40% of peak DC
const PLATEAU_TO_BAND = 7; //   80% of peak DC
/** The top band, where a ceiling shows up. */
const TOP_BAND = BAND_COUNT - 1;

/**
 * How far efficiency must fall before this is called clipping. The measured plateau holds
 * to within 0.01 points across the range, so two full points is well outside the noise
 * while still catching a ceiling the first day it is touched.
 */
const EFFICIENCY_DROP = 0.02;

/** Below this the unit is barely awake and the ratio is noise. */
const MIN_DC_W = 25;
/** A band with fewer samples than this cannot support a conclusion. */
const MIN_BAND_SAMPLES = 20;
/**
 * Longest gap credited to a sample when integrating lost energy. Readings are stored on
 * change or on a heartbeat, so a quiet stretch can leave a gap of hours.
 */
const MAX_GAP_MS = 10 * 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Look for a ceiling in one inverter's history. Null for anything that is not clipping. */
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
    The ceiling is the highest AC actually seen, not the top band's average: a clipped unit
    sits AT its limit, so the maximum is the limit and is comparable with the nameplate.
  */
  const clipped = inBand[TOP_BAND];
  const ceilingAcW = Math.max(...clipped.map((s) => s.acW));

  /*
    Lost energy, integrated over real gaps rather than assumed intervals: each clipped sample
    is credited with the capped time until the next sample anywhere in the series. The loss
    is what the plateau would have delivered from the available DC, less what came out.
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
