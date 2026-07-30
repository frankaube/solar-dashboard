import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const POLL_INTERVAL_MS = 30_000;
const LIFETIME_REFRESH_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 3_000;
/** Below this the contactor may be closed but the car is only trickling/settling. */
const CHARGING_THRESHOLD_W = 100;
/** Idle heartbeat: persist a row at least this often even without state changes. */
const HEARTBEAT_MS = 15 * 60_000;
/** A gap longer than this between charging samples splits two sessions. */
const SESSION_GAP_MS = 10 * 60_000;
/** Cap per-sample integration so missing data never inflates energy. */
const MAX_SAMPLE_GAP_MS = 2 * 60_000;
/** Solar sample must be within this window to count toward overlap. */
const SOLAR_PAIRING_WINDOW_MS = 10 * 60_000;

interface WallConnectorVitals {
  contactor_closed: boolean;
  vehicle_connected: boolean;
  session_s: number;
  grid_v: number;
  grid_hz: number;
  vehicle_current_a: number;
  handle_temp_c: number;
  session_energy_wh: number;
  evse_state: number;
}

interface WallConnectorLifetime {
  energy_wh: number;
  charge_starts: number;
  contactor_cycles: number;
  uptime_s: number;
}

export interface ChargerLiveDto {
  vehicleConnected: boolean;
  charging: boolean;
  powerW: number;
  sessionEnergyWh: number;
  sessionSeconds: number;
  gridVoltage: number;
  gridFrequency: number;
  handleTempC: number;
  lifetimeEnergyWh: number | null;
  chargeStarts: number | null;
  updatedAt: string;
}

export const CHARGER_HOST_SETTING = 'chargerHost';

@Injectable()
export class ChargerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChargerService.name);
  private host: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private live: ChargerLiveDto | null = null;
  private lifetime: WallConnectorLifetime | null = null;
  private lifetimeFetchedAt = 0;
  private lastStoredAt = 0;
  private lastStoredState: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: CHARGER_HOST_SETTING },
    });
    const host = setting?.value || process.env.CHARGER_HOST;
    if (!host) {
      this.logger.log('No charger configured — Wall Connector integration idle.');
      return;
    }
    this.applyHost(host);
  }

  /** Point at a (new) Wall Connector host; starts polling if it wasn't running. */
  applyHost(host: string): void {
    this.host = host;
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
      void this.poll();
    }
    this.logger.log(`Polling Wall Connector at ${host} every ${POLL_INTERVAL_MS} ms`);
  }

  getHost(): string | null {
    return this.host;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getLive(): ChargerLiveDto | null {
    return this.live;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    // Connection: close — the Wall Connector's embedded server has very few
    // sockets; holding a keep-alive slot starves other clients.
    const response = await fetch(`http://${this.host}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { connection: 'close' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private async poll(): Promise<void> {
    try {
      const vitals = await this.fetchJson<WallConnectorVitals>('/api/1/vitals');
      if (Date.now() - this.lifetimeFetchedAt > LIFETIME_REFRESH_MS) {
        try {
          this.lifetime = await this.fetchJson<WallConnectorLifetime>('/api/1/lifetime');
          this.lifetimeFetchedAt = Date.now();
        } catch {
          // vitals still useful without lifetime totals
        }
      }

      const powerW = vitals.grid_v * vitals.vehicle_current_a;
      const charging = vitals.contactor_closed && powerW > CHARGING_THRESHOLD_W;
      this.live = {
        vehicleConnected: vitals.vehicle_connected,
        charging,
        powerW,
        sessionEnergyWh: vitals.session_energy_wh,
        sessionSeconds: vitals.session_s,
        gridVoltage: vitals.grid_v,
        gridFrequency: vitals.grid_hz,
        handleTempC: vitals.handle_temp_c,
        lifetimeEnergyWh: this.lifetime?.energy_wh ?? null,
        chargeStarts: this.lifetime?.charge_starts ?? null,
        updatedAt: new Date().toISOString(),
      };

      const state = `${vitals.vehicle_connected}|${charging}`;
      const shouldStore =
        charging ||
        state !== this.lastStoredState ||
        Date.now() - this.lastStoredAt > HEARTBEAT_MS;
      if (shouldStore) {
        await this.prisma.chargerReading.create({
          data: {
            takenAt: new Date(),
            vehicleConnected: vitals.vehicle_connected,
            charging,
            power: powerW,
            sessionEnergyWh: vitals.session_energy_wh,
            gridVoltage: vitals.grid_v,
            handleTemp: vitals.handle_temp_c,
          },
        });
        this.lastStoredAt = Date.now();
        this.lastStoredState = state;
      }
    } catch (error) {
      this.logger.warn(`Wall Connector poll failed: ${(error as Error).message}`);
    }
  }

  /**
   * Group stored readings into charging sessions and compute, per session, how
   * much of the drawn energy overlapped concurrent solar production.
   */
  async getSessions(days: number): Promise<{
    sessions: Array<{
      startedAt: string;
      endedAt: string;
      energyWh: number;
      solarWh: number;
      solarPct: number;
      peakW: number;
    }>;
    totals: { energyWh: number; solarWh: number; solarPct: number };
  }> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [chargerRows, solarRows] = await Promise.all([
      this.prisma.chargerReading.findMany({
        where: { takenAt: { gte: since } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, charging: true, power: true, sessionEnergyWh: true },
      }),
      this.prisma.dtuReading.findMany({
        where: { takenAt: { gte: since } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, totalPower: true },
      }),
    ]);

    const solar = solarRows.map((row) => ({ t: row.takenAt.getTime(), w: Number(row.totalPower) }));
    let solarCursor = 0;
    const solarAt = (t: number): number => {
      while (solarCursor + 1 < solar.length && solar[solarCursor + 1].t <= t) solarCursor++;
      const sample = solar[solarCursor];
      if (!sample || Math.abs(sample.t - t) > SOLAR_PAIRING_WINDOW_MS) return 0;
      return sample.w;
    };

    interface Row {
      t: number;
      w: number;
      counter: number;
    }
    const charging: Row[] = chargerRows
      .filter((row) => row.charging)
      .map((row) => ({
        t: row.takenAt.getTime(),
        w: Number(row.power),
        counter: Number(row.sessionEnergyWh),
      }));

    const sessions: Array<{
      startedAt: string;
      endedAt: string;
      energyWh: number;
      solarWh: number;
      solarPct: number;
      peakW: number;
    }> = [];
    let current: Row[] = [];

    const finalize = (): void => {
      if (current.length < 2) {
        current = [];
        return;
      }
      const counters = current.map((row) => row.counter);
      const energyWh = Math.max(0, Math.max(...counters) - Math.min(...counters));
      let solarWh = 0;
      for (let i = 0; i < current.length - 1; i++) {
        const dtHours = Math.min(current[i + 1].t - current[i].t, MAX_SAMPLE_GAP_MS) / 3_600_000;
        solarWh += Math.min(current[i].w, solarAt(current[i].t)) * dtHours;
      }
      solarWh = Math.min(solarWh, energyWh);
      sessions.push({
        startedAt: new Date(current[0].t).toISOString(),
        endedAt: new Date(current[current.length - 1].t).toISOString(),
        energyWh: Math.round(energyWh),
        solarWh: Math.round(solarWh),
        solarPct: energyWh > 0 ? Math.round((solarWh / energyWh) * 100) : 0,
        peakW: Math.round(Math.max(...current.map((row) => row.w))),
      });
      current = [];
    };

    for (const row of charging) {
      if (current.length && row.t - current[current.length - 1].t > SESSION_GAP_MS) finalize();
      current.push(row);
    }
    finalize();

    const totalEnergy = sessions.reduce((a, s) => a + s.energyWh, 0);
    const totalSolar = sessions.reduce((a, s) => a + s.solarWh, 0);
    return {
      sessions: sessions.reverse(),
      totals: {
        energyWh: totalEnergy,
        solarWh: totalSolar,
        solarPct: totalEnergy > 0 ? Math.round((totalSolar / totalEnergy) * 100) : 0,
      },
    };
  }

  async getHistory(hours: number): Promise<Array<{ t: string; powerW: number; charging: boolean }>> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const rows: Array<{ takenAt: Date; power: unknown; charging: boolean }> =
      await this.prisma.chargerReading.findMany({
        where: { takenAt: { gte: since } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, power: true, charging: true },
      });
    return rows.map((row) => ({
      t: row.takenAt.toISOString(),
      powerW: Number(row.power),
      charging: row.charging,
    }));
  }
}
