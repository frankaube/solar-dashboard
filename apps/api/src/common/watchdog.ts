import { execFile } from 'node:child_process';

/**
 * Telling systemd the collector is still turning.
 *
 * `Restart=on-failure` only catches a process that *exits*. It does nothing for one that is
 * still running and no longer doing anything — which is the failure this install actually
 * had: readings stopped at 04:23 while the process stayed up, systemd saw a perfectly
 * healthy service, and nothing restarted it for three and a half hours.
 *
 * So the poll loop checks in. If the check-ins stop, systemd concludes the loop has wedged
 * and restarts the service, which is the one thing that reliably clears a stuck socket to a
 * DTU that only accepts one connection at a time.
 *
 * WHAT COUNTS AS ALIVE, and it is worth being exact: the ping happens when a poll cycle
 * *finishes*, whether it succeeded or failed. A DTU that is switched off is not a reason to
 * restart anything — the app is working correctly and reporting that it cannot reach the
 * gateway. What must not happen is a cycle that never comes back at all.
 */

/**
 * How long systemd waits before concluding the loop is gone, in seconds.
 *
 * Comfortably more than two poll intervals: the DTU accepts one connection at a time and a
 * poll timing out is ordinary, so a single missed cycle must never be enough. The unit file
 * carries the same number and the two have to agree.
 */
export const WATCHDOG_SEC = 900;

let unavailable = false;

/**
 * Notify systemd that the service is still working.
 *
 * A no-op anywhere there is no systemd: Windows, Docker without notify, a from-source run in
 * a terminal. `NOTIFY_SOCKET` being absent is the normal case for most installs and is not
 * worth a log line, let alone a failure.
 *
 * Uses systemd's own `systemd-notify` rather than writing the datagram directly. Node has no
 * AF_UNIX datagram support, and the alternatives are a native module — which would have to
 * build on a Pi, for a single line of output — or nothing. The process runs once per poll
 * cycle, which is once every five minutes.
 */
export function pingWatchdog(): void {
  if (unavailable || !process.env.NOTIFY_SOCKET) return;
  execFile('systemd-notify', ['WATCHDOG=1'], (error) => {
    /*
      Stop trying after the first failure rather than spawning a process every five minutes
      forever. If systemd-notify is missing or refuses, that will not change while this
      process lives, and the consequence is only that the watchdog goes unfed — which is
      exactly what a wedged loop looks like. Better to be restarted for a fixable reason than
      to keep a broken feed alive.
    */
    if (error) unavailable = true;
  });
}

/** Tell systemd the service is up. Required before any watchdog ping is accepted. */
export function notifyReady(): void {
  if (!process.env.NOTIFY_SOCKET) return;
  execFile('systemd-notify', ['--ready'], () => undefined);
}
