/**
 * How often to ask the Wall Connector for its vitals.
 *
 * The Gen 3's embedded web server exhausts itself under sustained polling: it keeps
 * answering ICMP and the Tesla app carries on working while port 80 stops accepting TCP
 * entirely, and it recovers only via a power cycle at the breaker. The same failure is
 * reported against evcc (evcc-io/evcc#28525) and Home Assistant, which polls at thirty
 * seconds around the clock. Hence: poll slowly while idle, back off once it goes quiet.
 */

/** While the car is actually taking power, and the live figure means something. */
export const ACTIVE_POLL_MS = 30_000;

/** Idle. Slow enough to be gentle, quick enough that a session shows up promptly. */
export const IDLE_POLL_MS = 5 * 60_000;

/** However bad it gets, still look occasionally: a power-cycled charger must be noticed. */
export const MAX_BACKOFF_MS = 15 * 60_000;

export interface CadenceInput {
  /** Contactor closed and real power flowing, not merely plugged in. */
  charging: boolean;
  /** Polls that have failed in a row. Zero on success. */
  consecutiveFailures: number;
}

export function nextPollDelayMs({ charging, consecutiveFailures }: CadenceInput): number {
  const base = charging ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  if (consecutiveFailures <= 0) return base;
  /* Doubling from the base rather than a fixed floor, so a charger that fails mid-session is
     retried briskly instead of jumping straight to the quarter-hour ceiling. */
  const backed = base * 2 ** consecutiveFailures;
  return Math.min(backed, MAX_BACKOFF_MS);
}
