/**
 * How often to ask the Wall Connector for its vitals.
 *
 * The Gen 3's embedded web server exhausts itself under sustained polling: it keeps
 * answering pings and the Tesla app carries on working while port 80 stops accepting
 * connections entirely, and it does not recover without a power cycle at the breaker. This
 * install has been caught by it twice, both times confirmed by the device answering ICMP
 * while refusing TCP. The same failure is reported against evcc (evcc-io/evcc#28525) and
 * Home Assistant, whose own integration polls at the thirty seconds this app used to use
 * around the clock.
 *
 * Two changes come out of that, and neither can fix the firmware:
 *
 * IT SLOWS DOWN WHEN NOTHING IS HAPPENING. Thirty seconds is the right cadence for watching
 * a car take power and pointless for watching an idle box: at that rate this app made about
 * 2,880 requests a day, of which roughly nineteen in twenty were asking an unoccupied
 * charger to confirm it was still unoccupied.
 *
 * IT BACKS OFF WHEN THE DEVICE STOPS ANSWERING. The old fixed interval had no failure path
 * at all, so when the API died it was asked again every thirty seconds for eighteen hours —
 * some 2,160 requests at a device that was already wedged. Nothing good can come of that,
 * and quite plausibly something bad.
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
  /*
    Doubling from the base rather than from a fixed floor, so a charger that fails mid-session
    is retried briskly at first — a single dropped request during a charge should not push the
    next look out to a quarter of an hour.
  */
  const backed = base * 2 ** consecutiveFailures;
  return Math.min(backed, MAX_BACKOFF_MS);
}
