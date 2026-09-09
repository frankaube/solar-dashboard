import { describe, expect, it } from 'vitest';
import { evaluateSnapshotAlerts } from '../src/alerts/alert-rules';
import { InverterSnapshot, PortSnapshot, SystemSnapshot } from '../src/hoymiles/types';

function inverter(serial: string, linkStatus = 1): InverterSnapshot {
  return {
    serialNumber: serial,
    gridVoltage: 250,
    gridFrequency: 60,
    activePower: 1000,
    reactivePower: 0,
    current: 4,
    powerFactor: 0.99,
    temperature: 60,
    powerLimitPct: 110,
    warningNumber: 0,
    linkStatus,
    rfSignal: -60,
  };
}

function port(serial: string, portNumber: number, power: number): PortSnapshot {
  return {
    inverterSerialNumber: serial,
    portNumber,
    voltage: 32,
    current: power / 32,
    power,
    energyDailyWh: 1000,
    energyTotalWh: 5000,
    errorCode: 0,
  };
}

function snapshot(inverters: InverterSnapshot[], ports: PortSnapshot[]): SystemSnapshot {
  return {
    dtuSerialNumber: 'TEST',
    takenAt: new Date(),
    totalPower: 1000,
    dailyEnergyWh: 10_000,
    inverters,
    ports,
  };
}

const QUAD = '10000000000001';

describe('evaluateSnapshotAlerts', () => {
  it('flags an offline inverter as serious', () => {
    const alerts = evaluateSnapshotAlerts(snapshot([inverter(QUAD, 0)], []), null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'inverter_offline', severity: 'serious' });
  });

  it('flags registered-but-silent inverters', () => {
    const alerts = evaluateSnapshotAlerts(snapshot([inverter(QUAD)], []), 12);
    const silent = alerts.find((alert) => alert.type === 'inverter_silent');
    expect(silent).toBeDefined();
    expect(silent!.message).toContain('11 of 12');
  });

  it('flags a port well below its siblings, scaled by severity', () => {
    const ports = [port(QUAD, 1, 300), port(QUAD, 2, 300), port(QUAD, 3, 200), port(QUAD, 4, 100)];
    const alerts = evaluateSnapshotAlerts(snapshot([inverter(QUAD)], ports), null);
    expect(alerts.map((alert) => alert.subjectKey)).toEqual([`${QUAD}:3`, `${QUAD}:4`]);
    expect(alerts[0].severity).toBe('warning'); // 200/300 = 67% of median
    expect(alerts[1].severity).toBe('serious'); // 100/300 = 33% of median
  });

  it('stays quiet at night (sibling median below the reference floor)', () => {
    const ports = [port(QUAD, 1, 10), port(QUAD, 2, 10), port(QUAD, 3, 1), port(QUAD, 4, 0)];
    expect(evaluateSnapshotAlerts(snapshot([inverter(QUAD)], ports), null)).toHaveLength(0);
  });

  it('ignores a large percentage built on small numbers', () => {
    // Two panels at different sun angles routinely differ by 80 W; a percentage gap
    // this size is not a fault.
    const ports = [port(QUAD, 1, 200), port(QUAD, 2, 200), port(QUAD, 3, 200), port(QUAD, 4, 145)];
    expect(evaluateSnapshotAlerts(snapshot([inverter(QUAD)], ports), null)).toHaveLength(0);
  });

  it('stays quiet in the old dawn/dusk noise band', () => {
    // A 100 W reference is dawn/dusk noise: below the floor, so a 28 W sibling is not judged.
    const ports = [port(QUAD, 1, 100), port(QUAD, 2, 100), port(QUAD, 3, 100), port(QUAD, 4, 28)];
    expect(evaluateSnapshotAlerts(snapshot([inverter(QUAD)], ports), null)).toHaveLength(0);
  });

  it('holds an open alert through the hysteresis band', () => {
    // 880/1000 = 88%: above the 85% opening threshold, below the 92% recovery one, and
    // short by 120 W so the absolute floor is not what decides this. Closed it stays
    // silent; already open it holds, rather than clearing and re-firing each poll.
    const ports = [1, 2, 3].map((n) => port(QUAD, n, 1000)).concat(port(QUAD, 4, 880));
    expect(evaluateSnapshotAlerts(snapshot([inverter(QUAD)], ports), null)).toHaveLength(0);

    const held = evaluateSnapshotAlerts(
      snapshot([inverter(QUAD)], ports),
      null,
      null,
      new Set([`port_underperforming|${QUAD}:4`]),
    );
    expect(held.map((a) => a.subjectKey)).toEqual([`${QUAD}:4`]);
  });

  it('clears an open alert once the port genuinely recovers', () => {
    // 950/1000 = 95%, past the recovery threshold.
    const ports = [1, 2, 3].map((n) => port(QUAD, n, 1000)).concat(port(QUAD, 4, 950));
    expect(
      evaluateSnapshotAlerts(
        snapshot([inverter(QUAD)], ports),
        null,
        null,
        new Set([`port_underperforming|${QUAD}:4`]),
      ),
    ).toHaveLength(0);
  });

  it('never compares a single-port inverter against itself', () => {
    const alerts = evaluateSnapshotAlerts(
      snapshot([inverter('18857592492764')], [port('18857592492764', 1, 350)]),
      null,
    );
    expect(alerts).toHaveLength(0);
  });

  it('returns nothing for a healthy system', () => {
    const ports = [1, 2, 3, 4].map((n) => port(QUAD, n, 300 + n));
    expect(evaluateSnapshotAlerts(snapshot([inverter(QUAD)], ports), 1)).toHaveLength(0);
  });

  it('flags snow cover: bright, freezing, and near-zero output', () => {
    const dead = snapshot([inverter(QUAD)], []);
    dead.totalPower = 40;
    const alerts = evaluateSnapshotAlerts(dead, null, { irradianceWm2: 620, temperatureC: -4 });
    expect(alerts.some((alert) => alert.type === 'snow_cover')).toBe(true);
  });

  it('does not cry snow in warm weather or when producing', () => {
    const producing = snapshot([inverter(QUAD)], []);
    producing.totalPower = 9000;
    expect(
      evaluateSnapshotAlerts(producing, null, { irradianceWm2: 620, temperatureC: -4 }).some(
        (alert) => alert.type === 'snow_cover',
      ),
    ).toBe(false);
    const dark = snapshot([inverter(QUAD)], []);
    dark.totalPower = 0;
    expect(
      evaluateSnapshotAlerts(dark, null, { irradianceWm2: 620, temperatureC: 18 }).some(
        (alert) => alert.type === 'snow_cover',
      ),
    ).toBe(false);
  });
});

/*
  Bright, warm and producing nothing is not snow — but it is still a fault. These cases pin
  that it raises array_dark rather than nothing at all.
*/
describe('an array that has simply stopped', () => {
  it('raises array_dark when the sky is bright and it is too warm for snow', () => {
    const dark = snapshot([inverter(QUAD)], []);
    dark.totalPower = 0;
    const alerts = evaluateSnapshotAlerts(dark, null, { irradianceWm2: 620, temperatureC: 18 });
    const raised = alerts.find((alert) => alert.type === 'array_dark');
    expect(raised).toBeDefined();
    expect(raised?.severity).toBe('serious');
  });

  it('says snow instead when it is freezing, rather than both', () => {
    // The two rules read the same evidence and must be mutually exclusive.
    const dark = snapshot([inverter(QUAD)], []);
    dark.totalPower = 40;
    const types = evaluateSnapshotAlerts(dark, null, { irradianceWm2: 620, temperatureC: -4 })
      .map((alert) => alert.type);
    expect(types).toContain('snow_cover');
    expect(types).not.toContain('array_dark');
  });

  it('stays quiet while the array is producing', () => {
    const fine = snapshot([inverter(QUAD)], []);
    fine.totalPower = 9000;
    expect(
      evaluateSnapshotAlerts(fine, null, { irradianceWm2: 620, temperatureC: 18 }).some(
        (alert) => alert.type === 'array_dark',
      ),
    ).toBe(false);
  });

  it('stays quiet under a dull sky, where no output proves nothing', () => {
    // 300 W/m² is thick overcast; low output proves nothing, so the rule needs an
    // unambiguous sky.
    const dark = snapshot([inverter(QUAD)], []);
    dark.totalPower = 0;
    expect(
      evaluateSnapshotAlerts(dark, null, { irradianceWm2: 300, temperatureC: 18 }).some(
        (alert) => alert.type === 'array_dark',
      ),
    ).toBe(false);
  });

  it('stays quiet at night, and with no weather configured at all', () => {
    const dark = snapshot([inverter(QUAD)], []);
    dark.totalPower = 0;
    expect(
      evaluateSnapshotAlerts(dark, null, { irradianceWm2: 0, temperatureC: 14 }).some(
        (alert) => alert.type === 'array_dark',
      ),
    ).toBe(false);
    // No irradiance to test means no claim can be made, so none is.
    expect(
      evaluateSnapshotAlerts(dark, null, null).some((alert) => alert.type === 'array_dark'),
    ).toBe(false);
  });
});

/**
 * Microinverters are powered by the panels above them, so at dusk they lose their link
 * and report offline — every evening, on every install.
 */
describe('inverters asleep after sunset', () => {
  const night = { irradianceWm2: 0, temperatureC: 8 };
  const overcastNoon = { irradianceWm2: 120, temperatureC: 8 };

  it('does not report offline inverters when there is no sun', () => {
    const alerts = evaluateSnapshotAlerts(snapshot([inverter(QUAD, 0)], []), null, night);
    expect(alerts.filter((a) => a.type === 'inverter_offline')).toHaveLength(0);
  });

  it('does not report silent inverters when there is no sun either', () => {
    // A sleeping inverter can present as offline OR as missing, depending on the DTU.
    const alerts = evaluateSnapshotAlerts(snapshot([inverter(QUAD)], []), 12, night);
    expect(alerts.filter((a) => a.type === 'inverter_silent')).toHaveLength(0);
  });

  it('still reports a dead inverter on a dark overcast day', () => {
    // Heavy overcast still reads 100+ W/m², well above the asleep threshold, so real
    // faults are not suppressed in bad weather.
    const alerts = evaluateSnapshotAlerts(snapshot([inverter(QUAD, 0)], []), null, overcastNoon);
    expect(alerts.filter((a) => a.type === 'inverter_offline')).toHaveLength(1);
  });

  it('still reports offline inverters when no weather is configured', () => {
    // Without a site location there is no irradiance to test, so this cannot suppress.
    const alerts = evaluateSnapshotAlerts(snapshot([inverter(QUAD, 0)], []), null, null);
    expect(alerts.filter((a) => a.type === 'inverter_offline')).toHaveLength(1);
  });

  it('leaves the snow-cover rule alone, which needs bright sky anyway', () => {
    const alerts = evaluateSnapshotAlerts(snapshot([inverter(QUAD, 0)], []), null, night);
    expect(alerts.filter((a) => a.type === 'snow_cover')).toHaveLength(0);
  });
});

/**
 * Measured on a real install: AppInfo reports 12 registered, RealData returns 11, and
 * `dtuPower` still includes the twelfth. Only the per-panel view is short — energy and
 * savings are correct — so a silent inverter still counted in the total is not serious.
 */
describe('silent inverters whose power is still in the total', () => {
  const daylight = { irradianceWm2: 600, temperatureC: 22 };

  /** 11 reporting inverters at 445 W each, with a DTU total that includes a 12th. */
  const withGap = (totalPower: number): SystemSnapshot => ({
    ...snapshot(
      Array.from({ length: 11 }, (_, i) => ({ ...inverter(String(1000 + i)), activePower: 445 })),
      [],
    ),
    totalPower,
  });

  it('downgrades to a warning and says the energy is unaffected', () => {
    // 4895 W reported by 11, 5445 W total => 550 W (10%) is the missing inverter.
    const alerts = evaluateSnapshotAlerts(withGap(5445), 12, daylight);
    const silent = alerts.find((a) => a.type === 'inverter_silent');
    expect(silent?.severity).toBe('warning');
    expect(silent?.message).toContain('still in the system total');
    expect(silent?.message).toContain('unaffected');
  });

  it('stays serious when the total does NOT account for them', () => {
    // Total matches the 11 that reported: the twelfth really is producing nothing.
    const alerts = evaluateSnapshotAlerts(withGap(4895), 12, daylight);
    const silent = alerts.find((a) => a.type === 'inverter_silent');
    expect(silent?.severity).toBe('serious');
    expect(silent?.message).toContain('reported no data');
  });

  it('does not read rounding noise as a whole inverter', () => {
    // 1% unaccounted is DC/AC and rounding, not a 4-panel inverter.
    const alerts = evaluateSnapshotAlerts(withGap(4944), 12, daylight);
    expect(alerts.find((a) => a.type === 'inverter_silent')?.severity).toBe('serious');
  });

  it('does not try to judge this at dawn, when everything is near zero', () => {
    // At 100 W total the two cases are indistinguishable; assume the worse one.
    const alerts = evaluateSnapshotAlerts(
      { ...withGap(100), inverters: withGap(100).inverters.map((i) => ({ ...i, activePower: 5 })) },
      12,
      daylight,
    );
    expect(alerts.find((a) => a.type === 'inverter_silent')?.severity).toBe('serious');
  });

  it('says nothing at all when every inverter reports', () => {
    const alerts = evaluateSnapshotAlerts(withGap(5445), 11, daylight);
    expect(alerts.find((a) => a.type === 'inverter_silent')).toBeUndefined();
  });
});

/*
  Hoymiles publishes no code table for the local protocol, and the per-port errorCode reads
  identically on healthy and failed units, so the only available signal is the warning count's
  magnitude against its neighbours.
*/
describe('an inverter complaining far more than its neighbours', () => {
  /*
    The count is cumulative and never falls, so firing on it alone would keep firing after a
    repair. The count only qualifies a unit that is also not working while its neighbours are.
  */
  const fleet = (counts: number[], powers: number[]) =>
    counts.map((count, i) => {
      const unit = inverter(`110000000000${i}`);
      unit.warningNumber = count;
      unit.activePower = powers[i];
      return unit;
    });

  const WORKING = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
  const HEALTHY = [13, 15, 11, 13, 15, 13, 11, 15, 13];

  it('flags the two that have stopped, with the real numbers off this array', () => {
    const alerts = evaluateSnapshotAlerts(
      snapshot(fleet([...HEALTHY, 4091, 6737], [...WORKING, 0, 0]), []),
      null,
    );
    const raised = alerts.filter((alert) => alert.type === 'inverter_warning_count');
    expect(raised).toHaveLength(2);
    expect(raised.every((alert) => alert.severity === 'serious')).toBe(true);
    expect(raised[0].message).toContain('median of 13');
  });

  it('clears itself the moment the unit produces again', () => {
    // The count still reads 4,091 after a repair, so recovery must be read from production.
    const recovered = evaluateSnapshotAlerts(
      snapshot(fleet([...HEALTHY, 4091, 6737], [...WORKING, 980, 1010]), []),
      null,
    );
    expect(recovered.some((alert) => alert.type === 'inverter_warning_count')).toBe(false);
  });

  it('says nothing about a grumbling unit that still does its job', () => {
    // A high count on a unit that is still producing is not a fault.
    const alerts = evaluateSnapshotAlerts(
      snapshot(fleet([13, 13, 13, 5000], [1000, 1000, 1000, 900]), []),
      null,
    );
    expect(alerts.some((alert) => alert.type === 'inverter_warning_count')).toBe(false);
  });

  it('stays quiet at night, when nothing can be told apart from anything else', () => {
    const alerts = evaluateSnapshotAlerts(
      snapshot(fleet([13, 13, 13, 4091], [0, 0, 0, 0]), []),
      null,
    );
    expect(alerts.some((alert) => alert.type === 'inverter_warning_count')).toBe(false);
  });

  it('says nothing when the whole fleet grumbles equally', () => {
    // Every inverter carries a non-zero count, so an absolute threshold would either cry
    // wolf on all of them or mean nothing.
    const alerts = evaluateSnapshotAlerts(
      snapshot(fleet([900, 950, 1000, 980], [1000, 1000, 1000, 0]), []),
      null,
    );
    expect(alerts.some((alert) => alert.type === 'inverter_warning_count')).toBe(false);
  });

  it('does not turn a freshly power-cycled fleet into an alarm', () => {
    // After a reboot the median is 0 or 1, and twenty times nothing is still nothing.
    const alerts = evaluateSnapshotAlerts(
      snapshot(fleet([0, 1, 0, 40], [1000, 1000, 1000, 0]), []),
      null,
    );
    expect(alerts.some((alert) => alert.type === 'inverter_warning_count')).toBe(false);
  });

  it('will not judge a fleet too small to have a typical member', () => {
    const alerts = evaluateSnapshotAlerts(snapshot(fleet([10, 9000], [1000, 0]), []), null);
    expect(alerts.some((alert) => alert.type === 'inverter_warning_count')).toBe(false);
  });
});

describe('the warning-count alert through dusk', () => {
  /*
    Opening needs the fleet to be working, so nothing is judged at night. Closing must not be
    merely the absence of that, or the alert would clear every evening and reopen every morning.
  */
  const unit = (serial: string, count: number, power: number) => {
    const inv = inverter(serial);
    inv.warningNumber = count;
    inv.activePower = power;
    return inv;
  };
  const DEAD = '11000000009999';
  const key = new Set([`inverter_warning_count|${DEAD}`]);
  const fleetAt = (power: number, deadPower: number) => [
    unit('110000000001', 13, power),
    unit('110000000002', 13, power),
    unit('110000000003', 15, power),
    unit(DEAD, 4091, deadPower),
  ];

  it('holds open after dark rather than reporting a recovery', () => {
    const held = evaluateSnapshotAlerts(snapshot(fleetAt(0, 0), []), null, null, key);
    expect(held.some((alert) => alert.type === 'inverter_warning_count')).toBe(true);
  });

  it('holds open through a dull afternoon, where the fleet is barely working', () => {
    const held = evaluateSnapshotAlerts(snapshot(fleetAt(80, 0), []), null, null, key);
    expect(held.some((alert) => alert.type === 'inverter_warning_count')).toBe(true);
  });

  it('closes only when the unit is seen producing alongside its neighbours', () => {
    const recovered = evaluateSnapshotAlerts(snapshot(fleetAt(1000, 900), []), null, null, key);
    expect(recovered.some((alert) => alert.type === 'inverter_warning_count')).toBe(false);
  });

  it('does not close on a flicker that is still far short of the fleet', () => {
    // 120 W against a fleet of 1,000 is not back at work; the gap between the opening and
    // recovery shares is what stops the two chattering.
    const held = evaluateSnapshotAlerts(snapshot(fleetAt(1000, 120), []), null, null, key);
    expect(held.some((alert) => alert.type === 'inverter_warning_count')).toBe(true);
  });

  it('still refuses to open in the dark, when it was not already open', () => {
    const closed = evaluateSnapshotAlerts(snapshot(fleetAt(0, 0), []), null, null, new Set());
    expect(closed.some((alert) => alert.type === 'inverter_warning_count')).toBe(false);
  });
});
