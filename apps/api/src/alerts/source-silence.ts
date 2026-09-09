import { AlertCandidate } from './alert-rules';

/**
 * A data source that has stopped reporting — stale data that still renders is
 * indistinguishable from a quiet afternoon.
 */

export interface SourceHealth {
  /** Stable key for hysteresis — must not change between polls. */
  key: string;
  /** How it should read in a sentence: "The EV charger". */
  label: string;
  lastSeenAt: Date | null;
  /** How often it is expected to report. */
  intervalMs: number;
  /** False while the source is deliberately switched off, so it is not chased. */
  configured: boolean;
}

/**
 * Hours-scale floor, not just missed intervals: a 30 s-cadence charger crosses ten missed
 * intervals in five minutes, which is a Wi-Fi hiccup rather than a source going away.
 */
const MIN_SILENCE_MS = 2 * 60 * 60 * 1000;
const MISSED_INTERVALS = 40;

function describeGap(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

export function evaluateSourceSilence(sources: SourceHealth[], now: Date): AlertCandidate[] {
  const alerts: AlertCandidate[] = [];
  for (const source of sources) {
    if (!source.configured) continue;

    // Never seen is a setup problem, not silence; a null timestamp measured as a gap
    // reports "no data for 56 years".
    if (!source.lastSeenAt) {
      alerts.push({
        type: 'source_silent',
        severity: 'warning',
        subjectKey: source.key,
        message: `${source.label} is configured but has never reported — check the address and that it is reachable`,
      });
      continue;
    }

    const gap = now.getTime() - source.lastSeenAt.getTime();
    const threshold = Math.max(MIN_SILENCE_MS, source.intervalMs * MISSED_INTERVALS);
    if (gap < threshold) continue;

    alerts.push({
      type: 'source_silent',
      severity: 'warning',
      subjectKey: source.key,
      message: `${source.label} has not reported for ${describeGap(gap)} — its figures are frozen at the last reading`,
    });
  }
  return alerts;
}
