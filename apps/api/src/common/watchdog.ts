import { execFile } from 'node:child_process';

/**
 * `Restart=on-failure` only catches a process that *exits*, not one still running and no
 * longer polling; a restart clears a stuck socket to a DTU that accepts one connection at a
 * time. Ping when a cycle *finishes*, succeeded or failed — only a cycle that never returns
 * should trigger a restart.
 */

/**
 * Seconds before systemd concludes the loop is gone. More than two poll intervals, since a
 * timed-out poll is ordinary. The unit file carries the same number and the two must agree.
 */
export const WATCHDOG_SEC = 900;

let unavailable = false;

/**
 * A no-op where `NOTIFY_SOCKET` is absent. Spawns `systemd-notify` rather than writing the
 * datagram, because Node has no AF_UNIX datagram support; once per five-minute poll cycle.
 */
export function pingWatchdog(): void {
  if (unavailable || !process.env.NOTIFY_SOCKET) return;
  execFile('systemd-notify', ['WATCHDOG=1'], (error) => {
    // Stop after the first failure: a missing or refusing systemd-notify will not change
    // while this process lives. The watchdog then goes unfed, which is acceptable.
    if (error) unavailable = true;
  });
}

/** Required before any watchdog ping is accepted. */
export function notifyReady(): void {
  if (!process.env.NOTIFY_SOCKET) return;
  execFile('systemd-notify', ['--ready'], () => undefined);
}
