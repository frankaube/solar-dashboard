import { PortSnapshot, SystemSnapshot } from '../hoymiles/types';

export const PORT_WARNING_RATIO = 0.85;
export const PORT_SERIOUS_RATIO = 0.5;
/** Hysteresis: an open port alert holds to here, not the opening threshold. 0.85–0.92 is the dead band. */
export const PORT_RECOVERY_RATIO = 0.92;
/** Below this sibling median, deviation is noise: at 50 W a 22 W gap reads as "44% below". */
export const MIN_REFERENCE_POWER_W = 150;
/** Also short in absolute watts, not just by ratio: 15% of 120 W is 18 W, which is noise. */
export const MIN_DEFICIT_W = 60;
const LINK_ONLINE = 1;
const PERCENT = 100;

/**
 * Below this irradiance the array is asleep, and offline inverters are expected.
 *
 * Microinverters are powered by the panels they sit under: when the sun goes down they
 * lose power, drop their link and report offline — every evening, on every install, by
 * design.
 *
 * 20 W/m² is deep twilight, well below usable power and comfortably under a
 * heavy-overcast noon (100+ W/m², where a genuinely dead inverter must still report).
 */
export const ASLEEP_IRRADIANCE_WM2 = 20;

/** Below this the accounting below cannot tell a reporting gap from a dead inverter. */
const SILENT_MIN_TOTAL_W = 300;

/**
 * Unaccounted share before a silent inverter is believed to be producing. One of twelve is
 * ~8%; 3% sits under that and over the DTU's rounding and DC/AC difference.
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
 * Bright sky + near-zero output + too warm for snow → the array has stopped. Harder than
 * the snow thresholds: at 400 W/m² a 23 kW array makes kilowatts, so 200 W is nothing.
 */
const DARK_MIN_IRRADIANCE = 400;
const DARK_MAX_SYSTEM_POWER_W = 200;

/**
 * An inverter logging far more warnings than the rest of the fleet.
 *
 * `warningNumber` is a cumulative count, not a code. Hoymiles publishes no table for the
 * local protocol and the per-port `errorCode` is identical on healthy and failed units alike
 * (0x0300FF00 across this whole array), so there is no fault name to be had.
 *
 * Compared against the fleet rather than a fixed number: every inverter carries a non-zero
 * count, so an absolute threshold would either cry wolf on all of them or mean nothing on a
 * different install. Observed here: healthy units 11–15, failed ones 4,091 and 6,737. The
 * floor stops a just-power-cycled fleet, where the median is 0 or 1, from alarming on a
 * handful of ordinary warnings.
 */
const WARN_COUNT_MULTIPLE = 20;
const WARN_COUNT_FLOOR = 100;
/** Below this the fleet is asleep and no unit can be told apart from another. */
const WARN_FLEET_WORKING_W = 150;
/** A unit doing less than this share of what its neighbours do is not working. */
const WARN_DEAD_SHARE = 0.1;
/** And this much to be called recovered, so the two cannot chatter. */
const WARN_RECOVER_SHARE = 0.3;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function hexSerial(serial: string): string {
  return BigInt(serial).toString(16).toUpperCase();
}

/** Pure: one snapshot to the conditions that hold. The engine diffs it against open alerts. */
export function evaluateSnapshotAlerts(
  snapshot: SystemSnapshot,
  expectedInverterCount: number | null,
  weather: WeatherContext | null = null,
  /** Condition keys (`type|subjectKey`) already open. Passed in to keep this pure. */
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

  // Same evidence, read the other way: snow is a diagnosis, this is the absence of one.
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

  // See ASLEEP_IRRADIANCE_WM2. Link and silence checks skip together, because a sleeping
  // inverter can present either way. With no weather configured they still fire at dusk.
  const asleep = weather !== null && weather.irradianceWm2 < ASLEEP_IRRADIANCE_WM2;

  /*
    THE COUNT ALONE MUST NOT OPEN THIS. `warningNumber` is cumulative and never falls, so a
    rule firing on it would keep firing after repair. It only qualifies a unit that is ALSO
    not working while its neighbours are, which makes it self-clearing.
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
        Dusk is not a recovery. Opening needs a working fleet; closing must NOT be merely
        the absence of that, or the alert would clear each evening and reopen each morning.
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
        On at least one firmware the DTU's own total disagrees with its per-inverter list:
        AppInfo says 12 registered, RealData returns 11, and `dtuPower` still includes the
        twelfth (10.1% unaccounted against an expected 9.5%). If the total still covers
        them, only the per-panel view is short.
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
      // Hysteresis: open needs a real recovery to clear, closed a real deficit to open.
      const isOpen = openKeys.has(`port_underperforming|${subjectKey}`);
      const threshold = isOpen ? PORT_RECOVERY_RATIO : PORT_WARNING_RATIO;
      if (ratio >= threshold) continue;
      // Both tests must fail, not either.
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
