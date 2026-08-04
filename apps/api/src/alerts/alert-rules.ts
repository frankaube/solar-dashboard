import { PortSnapshot, SystemSnapshot } from '../hoymiles/types';

export const PORT_WARNING_RATIO = 0.85;
export const PORT_SERIOUS_RATIO = 0.5;
/**
 * Hysteresis: once a port alert is open it stays open until the port recovers to
 * this ratio, not merely back past the opening threshold.
 *
 * Without this a panel sitting near the line crosses it on almost every poll. Real
 * example from one afternoon: the same port opened and closed eight times, once
 * living exactly five minutes — a single poll — and each cycle pushed two
 * notifications. The gap between 0.85 and 0.92 is the dead band that noise has to
 * clear before we call anything a change.
 */
export const PORT_RECOVERY_RATIO = 0.92;
/**
 * Below this sibling-median power, per-port deviation is noise (dawn/dusk/night).
 *
 * Was 50 W, which was far too low: at a 50 W reference a 22 W difference reads as
 * "44% below its siblings" and fires an alert about two panels that are both
 * essentially idle. Percentages are meaningless when the denominator is small.
 */
export const MIN_REFERENCE_POWER_W = 150;
/**
 * A port must also be short by this many watts in absolute terms, not just by ratio.
 * 15% of 120 W is 18 W — inside the noise of two panels at different angles, and not
 * worth waking someone for. This is the second half of the same idea as the floor
 * above: a ratio alone cannot tell you whether a gap matters.
 */
export const MIN_DEFICIT_W = 60;
const LINK_ONLINE = 1;
const PERCENT = 100;

/**
 * Below this irradiance the array is asleep, and offline inverters are expected.
 *
 * Microinverters are powered by the panels they sit under. When the sun goes down
 * they lose power, drop their link, and report offline — every evening, on every
 * installation, by design. Treating that as a fault produced a "serious" alert per
 * inverter at dusk: twelve of them on this system, twelve text messages, nightly.
 *
 * 20 W/m² is deep twilight — well below the point where any panel makes usable power,
 * and comfortably under a heavy-overcast noon (which still reads 100+ W/m² and where
 * a genuinely dead inverter should absolutely still be reported.)
 */
export const ASLEEP_IRRADIANCE_WM2 = 20;

/**
 * Below this the array is barely awake and the accounting below cannot tell a
 * reporting gap from a dead inverter — both look like zero.
 */
const SILENT_MIN_TOTAL_W = 300;

/**
 * How much of the total must be unaccounted for before we believe a silent inverter
 * is nonetheless producing.
 *
 * One of twelve inverters is about 8% of an evenly-sized array; 3% is well under that
 * and well over the rounding and DC/AC differences between the DTU's own total and the
 * sum of its per-inverter figures.
 */
const UNACCOUNTED_SHARE_FLOOR = 0.03;

export type AlertSeverity = 'warning' | 'serious';

export interface AlertCandidate {
  type:
    | 'inverter_offline'
    | 'inverter_silent'
    | 'port_underperforming'
    | 'snow_cover'
    /** The array does not add up — see array-census.ts. Raised outside the snapshot rules. */
    | 'array_mismatch'
    /** A configured data source stopped reporting — see source-silence.ts. */
    | 'source_silent'
    /** The utility has published another period — see utility-staleness.ts. */
    | 'utility_data_stale';
  severity: AlertSeverity;
  subjectKey: string;
  message: string;
}

export interface WeatherContext {
  irradianceWm2: number;
  temperatureC: number;
}

/** Bright sky + near-zero output + freezing temps → panels likely snow-covered. */
const SNOW_MIN_IRRADIANCE = 300;
const SNOW_MAX_SYSTEM_POWER_W = 200;
const SNOW_MAX_TEMP_C = 1;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function hexSerial(serial: string): string {
  return BigInt(serial).toString(16).toUpperCase();
}

/**
 * Pure evaluation of one snapshot into the set of conditions that currently hold.
 * The engine diffs this set against open alerts to decide what to open/close.
 */
export function evaluateSnapshotAlerts(
  snapshot: SystemSnapshot,
  expectedInverterCount: number | null,
  weather: WeatherContext | null = null,
  /**
   * Condition keys (`type|subjectKey`) already open. Passed in rather than held here
   * so this stays a pure function of its inputs — hysteresis needs to know what is
   * already open, but it does not need to own that state.
   */
  openKeys: ReadonlySet<string> = new Set(),
): AlertCandidate[] {
  const alerts: AlertCandidate[] = [];

  if (
    weather !== null &&
    weather.irradianceWm2 >= SNOW_MIN_IRRADIANCE &&
    weather.temperatureC <= SNOW_MAX_TEMP_C &&
    snapshot.totalPower < SNOW_MAX_SYSTEM_POWER_W
  ) {
    alerts.push({
      type: 'snow_cover',
      severity: 'warning',
      subjectKey: 'system',
      message:
        `Bright sky (${Math.round(weather.irradianceWm2)} W/m²) at ` +
        `${Math.round(weather.temperatureC)} °C but almost no production — panels likely snow-covered`,
    });
  }

  /*
    Nothing about a missing inverter is newsworthy while the sun is down — see
    ASLEEP_IRRADIANCE_WM2. Both link and silence checks are skipped together, because
    a sleeping inverter can present either way depending on how the DTU reports it.

    When no weather is configured there is no irradiance to test, so this cannot
    suppress and the alerts still fire at dusk. Coalescing (alert-policy) turns that
    into one message rather than one per inverter, which is the floor; setting a site
    location is what removes it entirely.
  */
  const asleep = weather !== null && weather.irradianceWm2 < ASLEEP_IRRADIANCE_WM2;

  if (!asleep) {
    for (const inverter of snapshot.inverters) {
      if (inverter.linkStatus !== LINK_ONLINE) {
        alerts.push({
          type: 'inverter_offline',
          severity: 'serious',
          subjectKey: inverter.serialNumber,
          message: `Inverter ${hexSerial(inverter.serialNumber)} is offline`,
        });
      }
    }

    if (expectedInverterCount !== null && snapshot.inverters.length < expectedInverterCount) {
      const missing = expectedInverterCount - snapshot.inverters.length;
      /*
        Two very different things look identical here, and calling both "serious" sent
        someone to check a roof for nothing.

        The DTU reports its own total separately from the per-inverter list, and on at
        least one firmware the two disagree: AppInfo says 12 registered, the cloud shows
        all 12 online, and RealData returns 11 — while `dtuPower` still includes the
        twelfth. Measured on that install, the unaccounted power was 10.1% of the total
        against an expected 9.5% for one of twelve inverters.

        So if the missing units' production still shows up in the DTU's total, nothing
        is lost but the detail: the energy and money figures are unaffected, and only
        the per-panel view is short. That is worth saying once, not worth an alarm.
        If the total does NOT account for them, production really is missing.
      */
      const reportedSum = snapshot.inverters.reduce((sum, inv) => sum + inv.activePower, 0);
      const unaccountedW = snapshot.totalPower - reportedSum;
      const producing = snapshot.totalPower > SILENT_MIN_TOTAL_W;
      const stillCounted =
        producing && unaccountedW > snapshot.totalPower * UNACCOUNTED_SHARE_FLOOR;

      alerts.push({
        type: 'inverter_silent',
        severity: stillCounted ? 'warning' : 'serious',
        subjectKey: 'system',
        message: stillCounted
          ? `${missing} of ${expectedInverterCount} inverters send no detail, but their ${Math.round(unaccountedW)} W is still in the system total — energy and savings are unaffected, per-panel data is short`
          : `${missing} of ${expectedInverterCount} registered inverter(s) reported no data`,
      });
    }
  }

  const portsByInverter = new Map<string, PortSnapshot[]>();
  for (const port of snapshot.ports) {
    const list = portsByInverter.get(port.inverterSerialNumber) ?? [];
    list.push(port);
    portsByInverter.set(port.inverterSerialNumber, list);
  }

  for (const [serial, ports] of portsByInverter) {
    if (ports.length < 2) continue; // no siblings to compare against
    const reference = median(ports.map((port) => port.power));
    if (reference < MIN_REFERENCE_POWER_W) continue;
    for (const port of ports) {
      const ratio = port.power / reference;
      const subjectKey = `${serial}:${port.portNumber}`;
      // Hysteresis: an already-open alert needs a real recovery to clear, while a
      // closed one needs a real deficit to open. Between the two it holds its state.
      const isOpen = openKeys.has(`port_underperforming|${subjectKey}`);
      const threshold = isOpen ? PORT_RECOVERY_RATIO : PORT_WARNING_RATIO;
      if (ratio >= threshold) continue;
      // Both tests must fail, not either: a big percentage on small numbers is noise,
      // and a big absolute gap on a bright day is real.
      if (reference - port.power < MIN_DEFICIT_W) continue;
      const deficitPct = Math.round((1 - ratio) * PERCENT);
      alerts.push({
        type: 'port_underperforming',
        severity: ratio < PORT_SERIOUS_RATIO ? 'serious' : 'warning',
        subjectKey,
        message:
          `Panel ${hexSerial(serial)} P${port.portNumber} at ${port.power.toFixed(0)} W — ` +
          `${deficitPct}% below its siblings (${reference.toFixed(0)} W)`,
      });
    }
  }

  return alerts;
}
