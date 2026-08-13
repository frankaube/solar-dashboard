import { DataSourceInfo, InverterDataSource, SystemSnapshot } from '../hoymiles/types';

const TIMEOUT_MS = 5_000;

/**
 * Fronius inverters via the local Solar API v1 (JSON, no auth). Values arrive in
 * real units already, so no scaling. Fronius is a string inverter — no per-panel
 * MLPE data — so ports are left empty; everything else (system + per-inverter
 * AC) populates. Implemented from Fronius's published API; fingerprint at
 * /solar_api/GetAPIVersion.cgi.
 */
export class FroniusClient implements InverterDataSource {
  constructor(private host: string) {}

  getHost(): string {
    return this.host;
  }

  setHost(host: string): void {
    this.host = host;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`http://${this.host}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Fronius HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  async fetchInfo(): Promise<DataSourceInfo> {
    const info = await this.get<{
      Body: { Data: Record<string, { UniqueID?: string; DT?: number; CustomName?: string }> };
    }>('/solar_api/v1/GetInverterInfo.cgi');
    const entries = Object.values(info.Body.Data ?? {});
    return {
      serialNumber: entries[0]?.UniqueID ?? 'fronius',
      model: 'Fronius',
      inverterCount: entries.length,
      pvCount: 0,
    };
  }

  /**
   * Site totals, grid flow, house load and battery — all in one request. The previous
   * implementation issued GetInverterInfo plus one GetInverterRealtimeData per inverter
   * (N+1) and still ended up with less: PowerFlow carries the grid/load/battery figures
   * that self-consumption accounting needs.
   */
  private async fetchPowerFlow(): Promise<FroniusPowerFlow | null> {
    try {
      const resp = await this.get<{ Body: { Data: FroniusPowerFlow } }>(
        '/solar_api/v1/GetPowerFlowRealtimeData.fcgi',
      );
      return resp.Body?.Data ?? null;
    } catch {
      return null; // older firmware — fall back to the per-inverter path
    }
  }

  /** GEN24 hybrids ship with BYD packs; Fronius exposes them on the same local API. */
  private async fetchStorageSoc(): Promise<number | undefined> {
    try {
      const resp = await this.get<{
        Body: { Data: Record<string, { Controller?: { StateOfCharge_Relative?: number } }> };
      }>('/solar_api/v1/GetStorageRealtimeData.cgi?Scope=System');
      const first = Object.values(resp.Body?.Data ?? {})[0];
      return first?.Controller?.StateOfCharge_Relative;
    } catch {
      return undefined; // no storage attached
    }
  }

  async fetchSnapshot(): Promise<SystemSnapshot> {
    const [flow, infoResp] = await Promise.all([
      this.fetchPowerFlow(),
      this.get<{ Body: { Data: Record<string, { UniqueID?: string }> } }>(
        '/solar_api/v1/GetInverterInfo.cgi',
      ),
    ]);
    const ids = Object.keys(infoResp.Body.Data ?? {});
    const serialOf = (id: string): string => infoResp.Body.Data[id]?.UniqueID ?? id;

    // PowerFlow reports per-inverter P as well, so the N+1 loop is only needed when
    // PowerFlow is unavailable (older firmware, or the Solar API partially disabled).
    const inverters = [];
    let totalPower: number = flow?.Site?.P_PV ?? 0;
    let dailyEnergyWh: number = flow?.Site?.E_Day ?? 0;

    if (flow?.Inverters) {
      for (const [id, inv] of Object.entries(flow.Inverters)) {
        inverters.push({
          serialNumber: serialOf(id),
          gridVoltage: 0,
          gridFrequency: 0,
          activePower: inv.P ?? 0,
          reactivePower: 0,
          current: 0,
          powerFactor: 1,
        });
      }
    } else {
      totalPower = 0;
      dailyEnergyWh = 0;
      for (const id of ids) {
        const d = await this.get<{ Body: { Data: FroniusCommon } }>(
          `/solar_api/v1/GetInverterRealtimeData.cgi?Scope=Device&DeviceId=${id}&DataCollection=CommonInverterData`,
        );
        const data = d.Body.Data;
        const pac = data.PAC?.Value ?? 0;
        totalPower += pac;
        dailyEnergyWh += data.DAY_ENERGY?.Value ?? 0;
        inverters.push({
          serialNumber: serialOf(id),
          gridVoltage: data.UAC?.Value ?? 0,
          gridFrequency: data.FAC?.Value ?? 0,
          activePower: pac,
          reactivePower: 0,
          current: data.IAC?.Value ?? 0,
          powerFactor: 1,
          // temperature/rfSignal deliberately omitted — Fronius doesn't report them here,
          // and writing 0 made "no reading" look like a real 0 °C.
          warningNumber: data.DeviceStatus?.ErrorCode,
          linkStatus: 1,
        });
      }
    }

    const batterySocPct = flow?.Inverters
      ? (Object.values(flow.Inverters)[0]?.SOC ?? (await this.fetchStorageSoc()))
      : await this.fetchStorageSoc();

    // Fronius signs P_Grid positive on import and P_Akku positive on discharge; the
    // shared model uses positive-charging, so the battery term is negated.
    // Fronius uses null (not absence) for "no meter/battery fitted".
    const num = (v: number | null | undefined): number | undefined => v ?? undefined;
    const load = num(flow?.Site?.P_Load);
    const akku = num(flow?.Site?.P_Akku);
    const flows =
      flow?.Site !== undefined
        ? {
            gridW: num(flow.Site.P_Grid),
            loadW: load === undefined ? undefined : Math.abs(load),
            batteryW: akku === undefined ? undefined : -akku,
            batterySocPct,
          }
        : undefined;

    return {
      dtuSerialNumber: serialOf(ids[0] ?? '1'),
      takenAt: new Date(),
      totalPower,
      dailyEnergyWh,
      totalEnergyWh: num(flow?.Site?.E_Total),
      flows,
      inverters,
      ports: [],
    };
  }
}

interface FroniusPowerFlow {
  Site?: {
    P_PV?: number | null;
    P_Grid?: number | null;
    P_Load?: number | null;
    P_Akku?: number | null;
    E_Day?: number | null;
    E_Total?: number | null;
  };
  Inverters?: Record<string, { P?: number; SOC?: number }>;
}

interface FroniusCommon {
  PAC?: { Value?: number };
  UAC?: { Value?: number };
  IAC?: { Value?: number };
  FAC?: { Value?: number };
  DAY_ENERGY?: { Value?: number };
  TOTAL_ENERGY?: { Value?: number };
  DeviceStatus?: { ErrorCode?: number; StatusCode?: number };
}

/** True if a host answers the Fronius API version probe. */
export async function isFronius(host: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}/solar_api/GetAPIVersion.cgi`, {
      signal: AbortSignal.timeout(3_000),
      headers: { connection: 'close' },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { APIVersion?: number; BaseURL?: string };
    return body.APIVersion !== undefined || Boolean(body.BaseURL);
  } catch {
    return false;
  }
}
