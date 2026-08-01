import { afterEach, describe, expect, it, vi } from 'vitest';
import { FroniusClient } from '../src/datasource/fronius.client';
import { OpenDtuClient } from '../src/datasource/opendtu.client';

function mockFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', (url: string) => {
    const path = url.replace(/^http:\/\/[^/]+/, '');
    const match = Object.keys(routes).find((r) => path.startsWith(r));
    if (!match) return Promise.resolve({ ok: false, status: 404 } as Response);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(routes[match]),
    } as Response);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('FroniusClient', () => {
  it('maps Solar API responses to a snapshot in real units', async () => {
    mockFetch({
      '/solar_api/v1/GetInverterInfo.cgi': { Body: { Data: { '1': { UniqueID: '12345' } } } },
      '/solar_api/v1/GetInverterRealtimeData.cgi': {
        Body: {
          Data: {
            PAC: { Value: 3200 },
            UAC: { Value: 240.5 },
            IAC: { Value: 13.3 },
            FAC: { Value: 59.98 },
            DAY_ENERGY: { Value: 18500 },
            DeviceStatus: { StatusCode: 7, ErrorCode: 0 },
          },
        },
      },
    });
    const snapshot = await new FroniusClient('x').fetchSnapshot();
    expect(snapshot.totalPower).toBe(3200);
    expect(snapshot.dailyEnergyWh).toBe(18500);
    expect(snapshot.inverters[0]).toMatchObject({
      serialNumber: '12345',
      gridVoltage: 240.5,
      gridFrequency: 59.98,
      activePower: 3200,
      current: 13.3,
    });
  });
});

describe('OpenDtuClient', () => {
  it('maps per-string DC channels to ports and AC to the inverter', async () => {
    mockFetch({
      '/api/livedata/status': {
        inverters: [
          {
            serial: '116480000001',
            reachable: true,
            AC: {
              '0': {
                Power: { v: 1234, u: 'W' },
                Voltage: { v: 241 },
                Frequency: { v: 60 },
                Current: { v: 5.1 },
                YieldDay: { v: 5000, u: 'Wh' },
              },
            },
            DC: {
              '0': { Power: { v: 620 }, Voltage: { v: 33 }, Current: { v: 18.8 }, YieldDay: { v: 2500 }, YieldTotal: { v: 3, u: 'kWh' } },
              '1': { Power: { v: 614 }, Voltage: { v: 32.6 }, Current: { v: 18.6 }, YieldDay: { v: 2500 }, YieldTotal: { v: 3, u: 'kWh' } },
            },
            INV: { '0': { Temperature: { v: 44.2 } } },
          },
        ],
        total: { Power: { v: 1234 }, YieldDay: { v: 5000 } },
      },
    });
    const snapshot = await new OpenDtuClient('x').fetchSnapshot();
    expect(snapshot.totalPower).toBe(1234);
    expect(snapshot.ports).toHaveLength(2);
    expect(snapshot.ports[0]).toMatchObject({ portNumber: 1, power: 620, voltage: 33 });
    expect(snapshot.ports[1].energyTotalWh).toBe(3000); // kWh → Wh
    expect(snapshot.inverters[0]).toMatchObject({ activePower: 1234, temperature: 44.2, gridFrequency: 60 });
  });
});
