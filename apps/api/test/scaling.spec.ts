import { describe, expect, it } from 'vitest';
import { formatHardwareVersion, toSystemSnapshot } from '../src/hoymiles/scaling';

// Values captured from the real DTU on 2026-07-24 (docs/dtu-research.md).
describe('toSystemSnapshot', () => {
  const raw = {
    deviceSerialNumber: '4100ABCDEF01',
    timestamp: 1784912656,
    ap: 3,
    cp: 0,
    sgsData: [
      {
        serialNumber: '18857592492764',
        voltage: 2520,
        frequency: 5998,
        activePower: 3584,
        reactivePower: -1315,
        current: 151,
        powerFactor: 938,
        temperature: 597,
        warningNumber: 1,
        linkStatus: 1,
        powerLimit: 1100,
        modulationIndexSignal: -73,
      },
    ],
    pvData: [
      {
        serialNumber: '18857592492764',
        portNumber: 1,
        voltage: 323,
        current: 1176,
        power: 3788,
        energyTotal: 3082,
        energyDaily: 2082,
        errorCode: 50396928,
      },
    ],
    dtuPower: '132170',
    dtuDailyEnergy: '67665',
  };

  it('converts raw integers into physical units', () => {
    const snapshot = toSystemSnapshot(raw);
    expect(snapshot.totalPower).toBeCloseTo(13217.0);
    expect(snapshot.dailyEnergyWh).toBe(67665);
    expect(snapshot.takenAt.getTime()).toBe(1784912656000);

    const inverter = snapshot.inverters[0];
    expect(inverter.gridVoltage).toBeCloseTo(252.0);
    expect(inverter.gridFrequency).toBeCloseTo(59.98);
    expect(inverter.activePower).toBeCloseTo(358.4);
    expect(inverter.current).toBeCloseTo(1.51);
    expect(inverter.powerFactor).toBeCloseTo(0.938);
    expect(inverter.temperature).toBeCloseTo(59.7);
    expect(inverter.powerLimitPct).toBeCloseTo(110.0);

    const port = snapshot.ports[0];
    expect(port.voltage).toBeCloseTo(32.3);
    expect(port.current).toBeCloseTo(11.76);
    expect(port.power).toBeCloseTo(378.8);
    expect(port.energyDailyWh).toBe(2082);
    expect(port.energyTotalWh).toBe(3082);
  });

  it('handles missing arrays and totals', () => {
    const snapshot = toSystemSnapshot({ deviceSerialNumber: 'X', timestamp: 0, ap: 1, cp: 0 });
    expect(snapshot.inverters).toEqual([]);
    expect(snapshot.ports).toEqual([]);
    expect(snapshot.totalPower).toBe(0);
  });
});

describe('formatHardwareVersion', () => {
  it('renders the label format (38411 → H09.06.11)', () => {
    expect(formatHardwareVersion(38411)).toBe('H09.06.11');
  });
});
