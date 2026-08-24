import { AlertCandidate } from './alert-rules';

/**
 * A data source that has stopped reporting.
 *
 * The app watches inverters closely and everything else not at all. A Tesla Wall Connector
 * stopped serving its API and the dashboard went on polling it every thirty seconds for
 * three days, logging a warning nobody reads, while the Car page quietly showed figures
 * that stopped moving. Nothing on any screen said so.
 *
 * That is the failure worth catching: not a device that is obviously broken, but one that
 * disappears while the rest of the app carries on looking healthy. Stale data that still
 * renders is more dangerous than no data, because it is indistinguishable from a quiet
 * afternoon.
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
 * How many missed reports before it counts as silence.
 *
 * Generous on purpose. A charger polled every thirty seconds crosses ten missed intervals
 * in five minutes, which would fire on a Wi-Fi hiccup; the threshold below is in hours, so
 * it distinguishes "went away" from "blinked". The cost of being slow here is a few hours
 * of not knowing; the cost of being fast is an alert people learn to ignore.
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

    /*
      Never seen at all is not silence — it is a source that has been configured and has
      not worked yet, which is a setup problem and reads completely differently. Saying "no
      data for 56 years" because a timestamp was null is the kind of output that destroys
      trust in every other number on the page.
    */
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
