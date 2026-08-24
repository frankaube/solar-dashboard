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
    /** Bright sky, nothing coming out, and too warm for snow to explain it. */
    | 'array_dark'
    /** One inverter has logged far more warnings than the rest of the fleet. */
    | 'inverter_warning_count'
    /** The array does not add up — see array-census.ts. Raised outside the snapshot rules. */
    | 'array_mismatch'
    /** A configured data source stopped reporting — see source-silence.ts. */
    | 'source_silent'
    /** The utility has published another period — see utility-staleness.ts. */
    | 'utility_data_stale'
    /** The meter is not counting what leaves the property — see unmetered-export.ts. */
    | 'utility_export_uncounted';
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

/**
 * Bright sky + near-zero output + too warm for snow → the array has simply stopped.
 *
 * Set harder than the snow thresholds on purpose. Snow is a guess offered gently; this is a
 * claim that production which should exist does not, and it should be reachable only when the
 * sky is unambiguous. At 400 W/m² a 23 kW array makes kilowatts, so 200 W is not a thin cloud
 * or an inverter waking up, it is nothing.
 */
const DARK_MIN_IRRADIANCE = 400;
const DARK_MAX_SYSTEM_POWER_W = 200;

/**
 * An inverter logging far more warnings than the rest of the fleet.
 *
 * `warningNumber` is a cumulative count, not a code. Hoymiles publishes no table for the
 * local protocol and the per-port `errorCode` is identical on healthy and failed units alike
 * (0x0300FF00 across this whole array), so there is no fault name to be had — only the fact
 * that one unit has complained thousands of times and its neighbours have not.
 *
 * Compared against the fleet rather than a fixed number, because every inverter carries a
 * non-zero count and an absolute threshold would either cry wolf on all of them or mean
 * nothing on a different install. On this array the healthy units sit at 11 to 15 and the two
 * failed ones at 4,091 and 6,737, so the multiple is not a close call — which is the point.
 * The floor stops a fleet that has just been power-cycled, where the median is 0 or 1, from
 * turning a handful of ordinary warnings into an alarm.
 */
const WARN_COUNT_MULTIPLE = 20;
const WARN_COUNT_FLOOR = 100;
/** Below this the fleet is asleep and no unit can be told apart from another. */
const WARN_FLEET_WORKING_W = 150;
/** A unit doing less than this share of what its neighbours do is not working. */
const WARN_DEAD_SHARE = 0.1;
/** And this much to be called recovered, so the two thresholds cannot chatter against each other. */
const WARN_RECOVER_SHARE = 0.3;

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
    The same evidence, read the other way.

    Bright sky and near-zero output raised nothing at all unless it was also freezing, so the
    app concluded "snow" or concluded nothing. On a warm afternoon an array that stops dead
    produced silence: an installer switched this system off at three o'clock under a clear
    sky and the only push that went out was the day's wrap-up, congratulating the owner on
    the production that had stopped.

    Snow is a diagnosis. This is the absence of one — the sky says there should be power and
    there is none, and the app does not know why. Serious, because on a clear afternoon it is
    the single most expensive thing that can quietly be true.
  */
  const brightAndDark =
    weather !== null &&
    weather.irradianceWm2 >= DARK_MIN_IRRADIANCE &&
    weather.temperatureC > SNOW_MAX_TEMP_C &&
    snapshot.totalPower < DARK_MAX_SYSTEM_POWER_W;
  if (brightAndDark) {
    alerts.push({
      type: 'array_dark',
      severity: 'serious',
      subjectKey: 'system',
      message:
        `Bright sky (${Math.round(weather.irradianceWm2)} W/m²) at ` +
        `${Math.round(weather.temperatureC)} °C and the array is producing ` +
        `${Math.round(snapshot.totalPower)} W. Something has stopped it`,
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

  /*
    The warning counter, which this app has been recording since the beginning and has never
    once looked at. Two units on this array had logged 4,091 and 6,737 warnings against a
    fleet median of 13, were producing nothing, and nothing said so — the column was collected
    and ignored.

    THE COUNT ALONE MUST NOT OPEN THIS, and that is the whole subtlety. It is cumulative and
    never falls, so a rule that fired on a high count would keep firing after the unit was
    repaired — a permanent unread notification of the exact kind the array census refuses to
    create, and useless for the question actually being asked of it, which is whether these
    two recover.

    So the count only ever qualifies a unit that is ALSO not working while its neighbours are.
    That makes it self-clearing: the morning one of these produces alongside the others, the
    condition stops holding and the alert closes on its own, which is the signal worth waiting
    for. A grumbling inverter that still does its job says nothing here, because a history of
    complaints is history.
  */
  const counts = snapshot.inverters
    .map((inverter) => inverter.warningNumber)
    .filter((count): count is number => typeof count === 'number');
  const fleetPower = median(snapshot.inverters.map((inverter) => inverter.activePower));
  const fleetWorking = fleetPower >= WARN_FLEET_WORKING_W;
  if (counts.length >= 3) {
    const typical = median(counts);
    for (const inverter of snapshot.inverters) {
      const count = inverter.warningNumber;
      if (typeof count !== 'number') continue;
      if (count < WARN_COUNT_FLOOR || count < typical * WARN_COUNT_MULTIPLE) continue;

      /*
        Hysteresis, because dusk is not a recovery.

        Opening needs the fleet to be genuinely working, so nothing is judged at night. But
        CLOSING must not simply be the absence of that: an alert that cleared whenever the
        fleet dropped below the working floor would close every evening as the sun went down
        and reopen every morning, reporting a recovery daily for a unit that had done nothing.
        This app has been here before — microinverters losing their link at dusk is why the
        offline rule is gated at all.

        So once open it holds until the unit is actually seen producing alongside its
        neighbours, which is the only evidence that means anything.
      */
      const isOpen = openKeys.has(`inverter_warning_count|${inverter.serialNumber}`);
      if (isOpen) {
        const recovered = fleetWorking && inverter.activePower > fleetPower * WARN_RECOVER_SHARE;
        if (recovered) continue;
      } else {
        if (!fleetWorking) continue;
        if (inverter.activePower > fleetPower * WARN_DEAD_SHARE) continue;
      }
      alerts.push({
        type: 'inverter_warning_count',
        severity: 'serious',
        subjectKey: inverter.serialNumber,
        message:
          `Inverter ${hexSerial(inverter.serialNumber)} is producing ` +
          `${Math.round(inverter.activePower)} W while the fleet averages ` +
          `${Math.round(fleetPower)} W, and has logged ${count} warnings against a median of ` +
          `${typical}`,
      });
    }
  }

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
