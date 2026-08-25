import { describe, expect, it, vi } from 'vitest';
import { ReadingsService } from '../src/readings/readings.service';
import { INVERTER_COUNT_SETTING_KEY, PV_COUNT_SETTING_KEY } from '../src/common/settings-keys';

/*
  "Inverters online" is counted against the roof, not against itself. The denominator is the
  count the gateway has registered; using the reporting inverters on both sides of the slash
  reads 11 / 11 with two units dead.
*/

/** A service wired to just the settings and the snapshot the summary reads. */
function serviceWith(options: {
  registeredInverters: number | null;
  reporting: number;
  linked?: number;
}) {
  const { registeredInverters, reporting, linked = reporting } = options;
  const settings: Record<string, string> = {};
  if (registeredInverters !== null) {
    settings[INVERTER_COUNT_SETTING_KEY] = String(registeredInverters);
  }
  settings[PV_COUNT_SETTING_KEY] = '46';

  const prisma = {
    setting: {
      findUnique: vi.fn(({ where }: { where: { key: string } }) =>
        Promise.resolve(settings[where.key] ? { value: settings[where.key] } : null),
      ),
    },
    pvPort: { count: vi.fn().mockResolvedValue(46) },
    dtuReading: {
      findFirst: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _max: { dailyEnergy: 12_000 } }),
    },
  };

  const inverters = Array.from({ length: reporting }, (_, i) => ({
    serialNumber: `1140${i}`,
    linkStatus: i < linked ? 1 : 0,
    activePower: 200,
    gridVoltage: 240,
    gridFrequency: 60,
  }));
  const collector = {
    getLastSnapshot: () => ({
      takenAt: new Date('2026-08-16T15:00:00Z'),
      totalPower: 2200,
      dailyEnergyWh: 12_000,
      inverters,
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ReadingsService(prisma as any, collector as any);
}

describe('invertersTotal', () => {
  it('counts the reporting inverters against the ones the gateway has registered', async () => {
    const summary = await serviceWith({ registeredInverters: 13, reporting: 11 }).getSummary();
    expect(summary.invertersOnline).toBe(11);
    expect(summary.invertersTotal).toBe(13);
  });

  it('does not count an inverter that reported without a link', async () => {
    const summary = await serviceWith({
      registeredInverters: 13,
      reporting: 12,
      linked: 11,
    }).getSummary();
    expect(summary.invertersOnline).toBe(11);
    expect(summary.invertersTotal).toBe(13);
  });

  it('reads whole when nothing is missing', async () => {
    const summary = await serviceWith({ registeredInverters: 13, reporting: 13 }).getSummary();
    expect(summary.invertersTotal).toBe(13);
    expect(summary.invertersOnline).toBe(13);
  });

  it('falls back to what is in front of it when the gateway has never said', async () => {
    // A fresh install, or a gateway that does not report the count: x / x is a floor, where
    // x / 0 would paint a healthy system as entirely absent.
    const summary = await serviceWith({ registeredInverters: null, reporting: 11 }).getSummary();
    expect(summary.invertersTotal).toBe(11);
  });

  it('ignores a zero count rather than dividing the roof by nothing', async () => {
    const summary = await serviceWith({ registeredInverters: 0, reporting: 11 }).getSummary();
    expect(summary.invertersTotal).toBe(11);
  });
});
