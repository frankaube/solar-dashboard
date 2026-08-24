import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BatterySource } from './types';
import { findBatteryVendor } from './vendors';
import { EcoFlowClient } from './ecoflow.client';

/**
 * Settings key for one vendor field, namespaced by vendor.
 *
 * Two vendors both wanting a "host" or an "apiKey" must not collide, and switching
 * vendor must not silently inherit the previous one's values.
 */
export function settingKeyFor(vendorId: string, field: string): string {
  return `battery.${vendorId}.${field}`;
}

export const BATTERY_VENDOR_SETTING = 'batteryVendor';
export const ECOFLOW_ACCESS_SETTING = 'ecoflowAccessKey';
export const ECOFLOW_SECRET_SETTING = 'ecoflowSecretKey';
export const ECOFLOW_SN_SETTING = 'ecoflowSn';

const POLL_INTERVAL_MS = 60_000;
const MAX_SAMPLE_GAP_MS = 10 * 60_000;

export interface BatteryDto {
  present: boolean;
  name?: string;
  model?: string;
  capacityKwh?: number | null;
  soc?: number;
  powerW?: number;
  reservePct?: number | null;
  todayChargedKwh?: number;
  todayDischargedKwh?: number;
  cycles?: number | null;
  roundTripPct?: number | null;
  series?: Array<{ t: string; soc: number; powerW: number }>;
}

@Injectable()
export class BatteryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BatteryService.name);
  private timer: NodeJS.Timeout | null = null;
  private source: BatterySource | null = null;
  private vendorName: string | null = null;
  /** Why the last poll failed, so the page can say so instead of showing a blank form. */
  private lastError: string | null = null;
  private last: Omit<BatteryDto, 'series' | 'todayChargedKwh' | 'todayDischargedKwh'> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async setting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  /**
   * Re-read config and rebuild the source (called on startup and after config saves).
   *
   * Vendor-agnostic now: the registry decides which fields a vendor needs and builds
   * its own client. This used to be an `if (vendor !== 'ecoflow') return`, so a second
   * vendor could not exist without editing the poll loop.
   */
  async reload(): Promise<void> {
    const vendorId = await this.setting(BATTERY_VENDOR_SETTING);
    const vendor = findBatteryVendor(vendorId);
    this.source = null;
    this.vendorName = null;
    this.lastError = null;
    if (!vendor) return;

    const config: Record<string, string> = {};
    for (const field of vendor.fields) {
      const value = await this.setting(settingKeyFor(vendor.id, field.key));
      if (value) config[field.key] = value;
    }
    this.source = vendor.createSource(config);
    this.vendorName = vendor.name;
    if (this.source) void this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.source) return;
    try {
      const state = await this.source.read();
      this.lastError = null;
      this.last = {
        present: true,
        name: state.name ?? 'Battery',
        model: state.model ?? this.vendorName ?? 'Battery',
        soc: state.soc,
        powerW: state.powerW,
        capacityKwh: state.capacityKwh ?? null,
        reservePct: state.reservePct ?? null,
        cycles: state.cycles ?? null,
      };
      await this.prisma.batteryReading.create({
        data: {
          takenAt: new Date(),
          soc: state.soc,
          powerW: state.powerW,
          socLow: state.reservePct ?? null,
        },
      });
    } catch (error) {
      /*
        Held rather than only logged. "Configured but unreachable" and "no battery
        configured" both used to render as an empty setup form, so an owner whose
        inverter had changed IP was shown the same screen as someone who had never
        set one up — with no hint that anything was wrong.
      */
      this.lastError = (error as Error).message;
      this.logger.warn(`Battery poll failed: ${this.lastError}`);
    }
  }

  async getState(): Promise<BatteryDto> {
    if (!this.last) return { present: false };
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.prisma.batteryReading.findMany({
      where: { takenAt: { gte: since } },
      orderBy: { takenAt: 'asc' },
      select: { takenAt: true, soc: true, powerW: true },
    });
    // Integrate today's charge/discharge from the stored power series.
    let charged = 0;
    let discharged = 0;
    for (let i = 0; i < rows.length - 1; i++) {
      const dtHours = Math.min(rows[i + 1].takenAt.getTime() - rows[i].takenAt.getTime(), MAX_SAMPLE_GAP_MS) / 3_600_000;
      const w = rows[i].powerW;
      if (w > 0) charged += (w * dtHours) / 1000;
      else discharged += (-w * dtHours) / 1000;
    }
    return {
      present: true,
      name: this.last.name,
      model: this.last.model,
      capacityKwh: this.last.capacityKwh,
      soc: Math.round(this.last.soc ?? 0),
      powerW: Math.round(this.last.powerW ?? 0),
      reservePct: this.last.reservePct,
      cycles: this.last.cycles,
      roundTripPct: null,
      todayChargedKwh: Number(charged.toFixed(1)),
      todayDischargedKwh: Number(discharged.toFixed(1)),
      series: rows.map((r) => ({ t: r.takenAt.toISOString(), soc: Math.round(r.soc), powerW: Math.round(r.powerW) })),
    };
  }

  /**
   * What is configured, without echoing any secret back.
   *
   * Values are returned so the form can be re-opened showing what was entered, except
   * for fields marked secret — those come back as a boolean "set" flag. Sending a
   * stored API key back to the browser to populate a password field is a habit worth
   * not having.
   */
  async getConfig(): Promise<object> {
    const vendorId = await this.setting(BATTERY_VENDOR_SETTING);
    const vendor = findBatteryVendor(vendorId);
    const values: Record<string, string> = {};
    const secretsSet: Record<string, boolean> = {};
    if (vendor) {
      for (const field of vendor.fields) {
        const value = await this.setting(settingKeyFor(vendor.id, field.key));
        if (field.secret) secretsSet[field.key] = Boolean(value);
        else if (value) values[field.key] = value;
      }
    }
    return {
      vendor: vendorId ?? null,
      configured: Boolean(this.source),
      values,
      secretsSet,
      /** Present and non-null when the source exists but the last read failed. */
      error: this.source ? this.lastError : null,
    };
  }

  /** List EcoFlow devices for the setup picker, using freshly-entered keys. */
  async listEcoFlowDevices(access: string, secret: string): Promise<object[]> {
    return new EcoFlowClient(access, secret).listDevices();
  }

  /**
   * Try a configuration before storing it.
   *
   * Saving credentials or an address that does not work, and only finding out a minute
   * later when the next poll fails silently, is the shape of bug this whole page was
   * accumulating. The caller gets the actual error text.
   */
  async testConfig(
    vendorId: string,
    config: Record<string, string>,
  ): Promise<{ ok: boolean; error?: string; soc?: number }> {
    const vendor = findBatteryVendor(vendorId);
    if (!vendor) return { ok: false, error: `Unknown battery vendor: ${vendorId}` };
    const source = vendor.createSource(config);
    if (!source) return { ok: false, error: 'Missing required fields' };
    try {
      const reading = await source.read();
      return { ok: true, soc: Math.round(reading.soc) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Store one vendor's configuration, clearing whatever the previous vendor used. */
  async saveVendorConfig(vendorId: string, config: Record<string, string>): Promise<void> {
    const vendor = findBatteryVendor(vendorId);
    if (!vendor) throw new Error(`Unknown battery vendor: ${vendorId}`);
    const set = (key: string, value: string): Promise<unknown> =>
      this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });

    await set(BATTERY_VENDOR_SETTING, vendorId);
    for (const field of vendor.fields) {
      const value = config[field.key];
      /*
        A blank secret means "leave what is stored", not "erase it". The form cannot
        show an existing key, so it submits an empty box whenever the owner edits some
        other field — and treating that as a deletion would log them out of their own
        battery every time they corrected a serial number.
      */
      if (value === undefined || (field.secret && value === '')) continue;
      await set(settingKeyFor(vendorId, field.key), value);
    }
    await this.reload();
  }

  /** Forget the configured battery entirely. */
  async clearConfig(): Promise<void> {
    await this.prisma.setting.deleteMany({
      where: { OR: [{ key: BATTERY_VENDOR_SETTING }, { key: { startsWith: 'battery.' } }] },
    });
    await this.reload();
    this.last = null;
  }
}
