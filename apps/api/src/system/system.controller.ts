import { BadRequestException, Body, Controller, Get, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ArrayCensusService, PANEL_COUNT_SETTING_KEY, PANEL_WATTS_SETTING_KEY } from './array-census.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportService } from './report.service';
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
  ) {}

  /**
   * What this install actually has, so the UI can stop describing somebody else's.
   *
   * Help text was written against the machine it was developed on — "DTU-Pro-S, local
   * protobuf on TCP 10081", "only EV and battery charging can be measured". Both are
   * false for a Fronius owner, and there is no way for them to know which parts of the
   * page apply to them. Anything the copy asserts about the hardware now comes from here.
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
    /*
      evcc wins when it is configured, because it is the source actually carrying the
      data — an install running evcc for a Kia should not be told it has a Tesla Wall
      Connector just because a host happens to be set.
    */
    const viaEvcc = this.evcc.configured;
    const charger = viaEvcc
      ? CHARGER_VENDORS.evcc
      : chargerHost
        ? CHARGER_VENDORS[DEFAULT_CHARGER_VENDOR]
        : null;
    /*
      A vehicle logger counts as present only once it has actually produced something.
      TESLAMATE_DATABASE_URL is set by docker-compose on every install whether or not
      anyone ever signed in, so treating configuration as presence would tell a household
      with no car that its car data was excluded from backups.
    */
    const vehicle = viaEvcc
      ? VEHICLE_SOURCES.evcc
      : vehicleRows
        ? VEHICLE_SOURCES[DEFAULT_VEHICLE_SOURCE]
        : null;
    /*
      What can actually be seen going into the house, rather than exported. The list is
      the honest answer to "why is my self-consumption 1%?" — and on an install with a
      whole-home meter it would be a different list, so it is built, not written.
    */
    const selfConsumptionSources: Array<{ id: string; label: string }> = [];
    if (battery) selfConsumptionSources.push({ id: 'battery', label: 'battery charging' });
    if (charger) selfConsumptionSources.push({ id: 'ev', label: 'EV charging' });
    /*
      evcc measures the solar share of each charging session directly, which is the only
      genuinely measured self-consumption available on an install with no metering plug —
      so it is named as its own source rather than folded into "EV charging".
    */
    if (viaEvcc) {
      selfConsumptionSources.push({ id: 'evcc', label: 'solar sent to the car, measured by evcc' });
    }
    /*
      The detailed version, with subnets and the gateway address in it. That phrasing is
      the most useful one on your own screen and exactly what the shareable report must
      not carry — so the report gets a boolean and writes its own sentence, and this gets
      the specifics.
    */
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

  /**
   * A shareable account of what this install looks like and what the app concluded.
   *
   * Served as Markdown for a download and as JSON for anything that wants to read it
   * programmatically. Both go through the same builder, so there is one place where the
   * decision about what may leave this machine is made.
   */
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

  /**
   * What the machine has had to do to keep itself running.
   *
   * A missing log is the normal case and returns an empty summary rather than an error: the
   * watchdog only exists on a systemd install, and a Docker or from-source run has nothing
   * to report. Never having needed a repair and not having a watchdog both look like
   * silence here, which is the right answer for a screen that is meant to stay quiet.
   */
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

  /**
   * What the paperwork says.
   *
   * The only input here a gateway cannot supply, and the only one that can reveal panels
   * it was never told about — so it is worth asking for even though it is one more thing
   * to type.
   */
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
    // No cache to clear: only the all-time peaks are cached, and those do not depend on
    // anything a form can change.
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
