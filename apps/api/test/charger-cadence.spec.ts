import { describe, expect, it } from 'vitest';
import {
  ACTIVE_POLL_MS,
  IDLE_POLL_MS,
  MAX_BACKOFF_MS,
  nextPollDelayMs,
} from '../src/charger/charger-cadence';

/*
  How hard to lean on a Wall Connector.

  The Gen 3's embedded web server exhausts itself under sustained polling: it keeps answering
  pings while port 80 stops accepting connections, and only a power cycle brings it back. The
  two mitigations pinned here are asking less when nothing is happening, and much less when
  it has stopped answering.
*/

describe('nextPollDelayMs', () => {
  it('watches closely while the car is actually taking power', () => {
    expect(nextPollDelayMs({ charging: true, consecutiveFailures: 0 })).toBe(ACTIVE_POLL_MS);
  });

  it('leaves an idle charger alone', () => {
    // At thirty seconds around the clock that is ~2,880 requests a day, nearly all of them
    // asking an unoccupied charger to confirm it is still unoccupied.
    expect(nextPollDelayMs({ charging: false, consecutiveFailures: 0 })).toBe(IDLE_POLL_MS);
    expect(IDLE_POLL_MS).toBeGreaterThan(ACTIVE_POLL_MS * 5);
  });

  it('backs off once it stops answering, instead of asking every thirty seconds for hours', () => {
    const first = nextPollDelayMs({ charging: false, consecutiveFailures: 1 });
    const second = nextPollDelayMs({ charging: false, consecutiveFailures: 2 });
    expect(first).toBeGreaterThan(IDLE_POLL_MS);
    expect(second).toBeGreaterThan(first);
  });

  it('retries briskly at first when a charge session drops a request', () => {
    // Doubling from the base rather than a fixed floor: one dropped request mid-charge must
    // not push the next look out to a quarter of an hour and lose the session's resolution.
    expect(nextPollDelayMs({ charging: true, consecutiveFailures: 1 })).toBe(ACTIVE_POLL_MS * 2);
    expect(nextPollDelayMs({ charging: true, consecutiveFailures: 1 })).toBeLessThan(IDLE_POLL_MS);
  });

  it('never stops looking entirely, however long it has been down', () => {
    // A charger that has been power-cycled has to be noticed without anyone restarting the app.
    expect(nextPollDelayMs({ charging: false, consecutiveFailures: 99 })).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBeLessThanOrEqual(15 * 60_000);
  });

  it('is monotonic in failures, so a longer outage is never asked more often', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((consecutiveFailures) =>
      nextPollDelayMs({ charging: false, consecutiveFailures }),
    );
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
  });

  it('costs an order of magnitude fewer requests over a realistic day', () => {
    // Two hours charging and twenty-two idle, against a flat thirty seconds.
    const before = (24 * 3600_000) / 30_000;
    const after =
      (2 * 3600_000) / nextPollDelayMs({ charging: true, consecutiveFailures: 0 }) +
      (22 * 3600_000) / nextPollDelayMs({ charging: false, consecutiveFailures: 0 });
    expect(before).toBeCloseTo(2880, 0);
    expect(after).toBeLessThan(before / 5);
  });
});
