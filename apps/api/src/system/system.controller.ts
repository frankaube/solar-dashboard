import { BadRequestException, Body, Controller, Get, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ArrayCensusService, PANEL_COUNT_SETTING_KEY, PANEL_WATTS_SETTING_KEY } from './array-census.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportService } from './report.service';
import { SourcesService } from './sources.service';
import { EvccService } from '../evcc/evcc.service';
import { DEFAULT_VENDOR, INVERTER_VENDORS } from '../datasource/vendors';
import { SOLAR_VENDOR_SETTING } from '../collector/collector.service';
import { CHARGER_HOST_SETTING } from '../charger/charger.service';
import { DTU_HOST_SETTING } from '../collector/collector.service';
import * as os from 'node:os';
import { readFile } from 'node:fs/promises';
import { RECOVERY_LOG, parseRecoveryLog, summariseRecovery } from './recovery';
import { assessDiscoveryReach } from '../devices/discovery-reach';
import {
  CHARGER_VENDORS,
  DEFAULT_CHARGER_VENDOR,
  DEFAULT_VEHICLE_SOURCE,
  VEHICLE_SOURCES,
} from '../charger/vendors';

@Controller('system')
export class SystemController {
  constructor(
    private readonly census: ArrayCensusService,
    private readonly prisma: PrismaService,
    private readonly report: ReportService,
    private readonly evcc: EvccService,
    private readonly sourcesService: SourcesService,
  ) {}

  /**
   * What this install actually has. Hard-coded help text ("DTU-Pro-S, protobuf on TCP
   * 10081") is false for a Fronius owner, so the copy's hardware claims come from here.
   */
  @Get('capabilities')
  async capabilities(): Promise<object> {
    const vendorId = (await this.readSetting(SOLAR_VENDOR_SETTING)) ?? DEFAULT_VENDOR;
    const vendor = INVERTER_VENDORS[vendorId];
    const [chargerHost, battery, vehicleRows] = await Promise.all([
      this.readSetting(CHARGER_HOST_SETTING),
      this.prisma.batteryReading.findFirst({ select: { id: true } }),
      this.prisma.chargerReading.findFirst({ select: { id: true } }),
    ]);
    // evcc wins when configured: it is the source actually carrying the data.
    const viaEvcc = this.evcc.configured;
    const charger = viaEvcc
      ? CHARGER_VENDORS.evcc
      : chargerHost
        ? CHARGER_VENDORS[DEFAULT_CHARGER_VENDOR]
        : null;
    // Present only once it has produced something: docker-compose sets
    // TESLAMATE_DATABASE_URL on every install, signed in or not.
    const vehicle = viaEvcc
      ? VEHICLE_SOURCES.evcc
      : vehicleRows
        ? VEHICLE_SOURCES[DEFAULT_VEHICLE_SOURCE]
        : null;
    // Built, not written: an install with a whole-home meter has a different list.
    const selfConsumptionSources: Array<{ id: string; label: string }> = [];
    if (battery) selfConsumptionSources.push({ id: 'battery', label: 'battery charging' });
    if (charger) selfConsumptionSources.push({ id: 'ev', label: 'EV charging' });
    // evcc measures each session's solar share directly, the only measured
    // self-consumption without a metering plug.
    if (viaEvcc) {
      selfConsumptionSources.push({ id: 'evcc', label: 'solar sent to the car, measured by evcc' });
    }
    // Detailed, with subnets and the gateway address; the report gets a boolean instead.
    const reach = assessDiscoveryReach(
      Object.values(os.networkInterfaces()).flat().filter((i): i is os.NetworkInterfaceInfo => Boolean(i)),
      await this.readSetting(DTU_HOST_SETTING),
    );
    return {
      solar: vendor ? { id: vendor.id, name: vendor.name } : null,
      discovery: {
        onDeviceSubnet: reach.onDeviceSubnet,
        localSubnets: reach.localSubnets,
        blindReason: reach.broadcastBlindReason,
      },
      pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || null,
      charger: charger ? { id: charger.id, name: charger.name } : null,
      vehicle: vehicle
        ? { id: vehicle.id, name: vehicle.name, setupUrl: vehicle.setupUrl }
        : null,
      metricsPath: '/api/metrics',
      healthPath: '/api/status',
      selfConsumptionSources,
    };
  }

  private async readSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value?.trim() || null;
  }

  /** Markdown and JSON share one builder, so redaction is decided in one place. */
  @Get('report.md')
  async reportMarkdown(@Res() res: Response): Promise<void> {
    const body = await this.report.markdown();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="solar-report-${stamp}.md"`);
    res.send(body);
  }

  @Get('report')
  report_(): Promise<object> {
    return this.report.build();
  }

  /** A missing log is normal — the watchdog only exists on a systemd install. */
  @Get('recovery')
  async recovery(): Promise<object> {
    try {
      const text = await readFile(RECOVERY_LOG, 'utf8');
      return summariseRecovery(parseRecoveryLog(text));
    } catch {
      return summariseRecovery([]);
    }
  }

  /** Every claim about how big this array is, and where they disagree. */
  @Get('census')
  get(): Promise<object> {
    return this.census.get();
  }

  /** Every source, and whether it is actually being read. See sources.ts. */
  @Get('sources')
  sources(): Promise<object> {
    return this.sourcesService.get();
  }

  /** The only input a gateway cannot supply, and the only one that reveals unknown panels. */
  @Put('array')
  async setArray(@Body() body: { panels?: number | null; wattsPerPanel?: number | null }): Promise<object> {
    const panels = body?.panels;
    const watts = body?.wattsPerPanel;
    // Blank clears; anything present must be sane. A typo here would invent a fault.
    const clearing = !panels && !watts;
    if (!clearing) {
      if (!Number.isFinite(panels) || (panels as number) < 1 || (panels as number) > 500) {
        throw new BadRequestException('panels must be between 1 and 500');
      }
      if (!Number.isFinite(watts) || (watts as number) < 50 || (watts as number) > 1000) {
        throw new BadRequestException('wattsPerPanel must be between 50 and 1000');
      }
    }
    await this.write(PANEL_COUNT_SETTING_KEY, clearing ? '' : String(Math.round(panels as number)));
    await this.write(PANEL_WATTS_SETTING_KEY, clearing ? '' : String(Math.round(watts as number)));
    // No cache to clear: only the all-time peaks are cached, and no form changes those.
    return this.census.get();
  }

  @Get('array')
  async array(): Promise<object> {
    const [panels, wattsPerPanel] = await Promise.all([
      this.read(PANEL_COUNT_SETTING_KEY),
      this.read(PANEL_WATTS_SETTING_KEY),
    ]);
    return { panels, wattsPerPanel };
  }

  private async read(key: string): Promise<number | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    const value = Number(row?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  private async write(key: string, value: string): Promise<void> {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}
