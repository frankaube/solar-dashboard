import { DataSourceInfo, InverterDataSource, PortSnapshot, SystemSnapshot } from '../hoymiles/types';

const TIMEOUT_MS = 5_000;

/** OpenDTU/AhoyDTU value wrapper: { v: number, u: "W" | "Wh" | "kWh" | ... }. */
interface OdValue {
  v?: number;
  u?: string;
}
type OdChannel = Record<string, OdValue>;

interface OdInverter {
  serial?: string;
  name?: string;
  reachable?: boolean;
  producing?: boolean;
  AC?: Record<string, OdChannel>;
  DC?: Record<string, OdChannel>;
  INV?: Record<string, OdChannel>;
}

interface OdStatus {
  inverters?: OdInverter[];
  total?: { Power?: OdValue; YieldDay?: OdValue };
}

function wh(value: OdValue | undefined): number {
  if (!value?.v) return 0;
  return value.u === 'kWh' ? value.v * 1000 : value.v;
}

/**
 * OpenDTU / AhoyDTU — community firmware for Hoymiles hardware with a clean local
 * REST API and full per-string (per-panel) data, so it maps directly to the roof
 * view. Also sidesteps the DTU-Pro-S local pagination bug. Implemented from the
 * documented /api/livedata/status shape; fingerprint at /api/system/status.
 */
export class OpenDtuClient implements InverterDataSource {
  constructor(private host: string) {}

  getHost(): string {
    return this.host;
  }

  setHost(host: string): void {
    this.host = host;
  }

  private async status(): Promise<OdStatus> {
    const response = await fetch(`http://${this.host}/api/livedata/status`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OpenDTU HTTP ${response.status}`);
    return (await response.json()) as OdStatus;
  }

  async fetchInfo(): Promise<DataSourceInfo> {
    const status = await this.status();
    const inverters = status.inverters ?? [];
    const pvCount = inverters.reduce((sum, inv) => sum + Object.keys(inv.DC ?? {}).length, 0);
    return {
      serialNumber: inverters[0]?.serial ?? 'opendtu',
      model: 'OpenDTU',
      inverterCount: inverters.length,
      pvCount,
    };
  }

  async fetchSnapshot(): Promise<SystemSnapshot> {
    const status = await this.status();
    const invs = status.inverters ?? [];
    const ports: PortSnapshot[] = [];
    let dailyEnergyWh = 0;

    const inverters = invs.map((inv) => {
      const ac = inv.AC?.['0'] ?? {};
      dailyEnergyWh += wh(ac.YieldDay);
      const serial = inv.serial ?? inv.name ?? 'inv';
      for (const [dcId, dc] of Object.entries(inv.DC ?? {})) {
        ports.push({
          inverterSerialNumber: serial,
          portNumber: Number(dcId) + 1,
          voltage: dc.Voltage?.v ?? 0,
          current: dc.Current?.v ?? 0,
          power: dc.Power?.v ?? 0,
          energyDailyWh: wh(dc.YieldDay),
          energyTotalWh: wh(dc.YieldTotal),
          errorCode: 0,
        });
      }
      return {
        serialNumber: serial,
        gridVoltage: ac.Voltage?.v ?? 0,
        gridFrequency: ac.Frequency?.v ?? 0,
        activePower: ac.Power?.v ?? 0,
        reactivePower: ac.ReactivePower?.v ?? 0,
        current: ac.Current?.v ?? 0,
        powerFactor: ac.PowerFactor?.v ?? 1,
        temperature: inv.INV?.['0']?.Temperature?.v ?? 0,
        powerLimitPct: inv.INV?.['0']?.['Limit_relative']?.v ?? 100,
        warningNumber: 0,
        linkStatus: inv.reachable ? 1 : 0,
        rfSignal: 0,
      };
    });

    return {
      dtuSerialNumber: invs[0]?.serial ?? 'opendtu',
      takenAt: new Date(),
      totalPower: status.total?.Power?.v ?? inverters.reduce((s, i) => s + i.activePower, 0),
      dailyEnergyWh: dailyEnergyWh || wh(status.total?.YieldDay),
      inverters,
      ports,
    };
  }
}

export async function isOpenDtu(host: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}/api/system/status`, {
      signal: AbortSignal.timeout(3_000),
      headers: { connection: 'close' },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { hostname?: unknown; sdkversion?: unknown; git_hash?: unknown };
    return 'git_hash' in body || 'sdkversion' in body || 'hostname' in body;
  } catch {
    return false;
  }
}
