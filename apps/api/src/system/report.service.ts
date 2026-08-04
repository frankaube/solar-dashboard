import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SITE_TIMEZONE } from '../common/localdate';
import { describeBuild } from '../common/build-info';
import { INVERTER_VENDORS, DEFAULT_VENDOR } from '../datasource/vendors';
import { SOLAR_VENDOR_SETTING } from '../collector/collector.service';
import { CHARGER_HOST_SETTING } from '../charger/charger.service';
import {
  CHARGER_VENDORS,
  DEFAULT_CHARGER_VENDOR,
  DEFAULT_VEHICLE_SOURCE,
  VEHICLE_SOURCES,
} from '../charger/vendors';
import { ArrayCensusService } from './array-census.service';
import { ReportInput, buildReportMarkdown } from './diagnostic-report';
import { resolveProgram } from '../readings/reward-programs';
import * as os from 'node:os';
import { assessDiscoveryReach } from '../devices/discovery-reach';
import { DTU_HOST_SETTING } from '../collector/collector.service';

/** A poll this far apart means the app was not running, not that the sun was down. */
const GAP_MINUTES = 15;

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly census: ArrayCensusService,
  ) {}

  private async setting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value?.trim() || null;
  }

  /**
   * The offset now, and whether it moves.
   *
   * Derived rather than reported, because the zone NAME is the identifying part — see
   * diagnostic-report.ts. January and July are compared to detect daylight saving without
   * needing a table of rules.
   */
  private zoneShape(): { utcOffsetMinutes: number; observesDst: boolean } {
    const offsetAt = (iso: string): number => {
      const at = new Date(iso);
      const local = new Date(at.toLocaleString('en-US', { timeZone: SITE_TIMEZONE }));
      const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
      return Math.round((local.getTime() - utc.getTime()) / 60_000);
    };
    const january = offsetAt('2026-01-15T12:00:00Z');
    const july = offsetAt('2026-07-15T12:00:00Z');
    return { utcOffsetMinutes: offsetAt(new Date().toISOString()), observesDst: january !== july };
  }

  private async collectionGaps(): Promise<Array<{ startedAt: string; minutes: number }>> {
    const rows = await this.prisma.dtuReading.findMany({
      orderBy: { takenAt: 'asc' },
      select: { takenAt: true },
    });
    const gaps: Array<{ startedAt: string; minutes: number }> = [];
    for (let i = 1; i < rows.length; i++) {
      const minutes = (rows[i].takenAt.getTime() - rows[i - 1].takenAt.getTime()) / 60_000;
      if (minutes > GAP_MINUTES) {
        gaps.push({ startedAt: rows[i - 1].takenAt.toISOString(), minutes: Math.round(minutes) });
      }
    }
    return gaps;
  }

  async build(): Promise<ReportInput> {
    const [census, vendorId, chargerHost, vehicleRows] = await Promise.all([
      this.census.get(),
      this.setting(SOLAR_VENDOR_SETTING),
      this.setting(CHARGER_HOST_SETTING),
      this.prisma.chargerReading.findFirst({ select: { id: true } }),
    ]);

    const inverters = await this.prisma.microinverter.findMany({
      select: { _count: { select: { ports: true } } },
    });
    const portsPerInverter = inverters
      .map((inv) => inv._count.ports)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    const [peakSystem, peakPanel, days, lifetime, bestDay] = await Promise.all([
      this.prisma.dtuReading.aggregate({ _max: { totalPower: true } }),
      this.prisma.portReading.aggregate({ _max: { power: true } }),
      this.prisma.dtuReading.findMany({ distinct: ['localDate'], select: { localDate: true } }),
      this.prisma.dtuReading.groupBy({ by: ['localDate'], _max: { dailyEnergy: true } }),
      this.prisma.dtuReading.aggregate({ _max: { dailyEnergy: true } }),
    ]);
    const lifetimeKwh = lifetime.reduce((sum, day) => sum + (day._max.dailyEnergy ?? 0), 0) / 1000;

    const alertRows = await this.prisma.alert.groupBy({
      by: ['type'],
      _count: { _all: true },
      // Grouped by type and open/closed only. Never by subjectKey — that is a serial.
    });
    const openRows = await this.prisma.alert.groupBy({
      by: ['type'],
      where: { closedAt: null },
      _count: { _all: true },
    });
    const openByType = new Map(openRows.map((r) => [r.type, r._count._all]));
    const alerts = alertRows.map((row) => ({
      type: row.type,
      open: openByType.get(row.type) ?? 0,
      closedEver: row._count._all - (openByType.get(row.type) ?? 0),
    }));

    /*
      Grouped in SQL by vendor and kind, which is also the redaction: the row that reaches
      the report has no id to join back to a name, a host or a MAC address.
    */
    const deviceRows = await this.prisma.device.findMany({
      where: { enabled: true },
      select: { id: true, vendor: true, kind: true },
    });
    const powered = await this.prisma.deviceReading.groupBy({
      by: ['deviceId'],
      _count: { powerW: true, _all: true },
    });
    const byDevice = new Map(powered.map((p) => [p.deviceId, p._count]));
    const grouped = new Map<string, { vendor: string; kind: string; count: number; metersPower: boolean; readings: number }>();
    for (const device of deviceRows) {
      const key = `${device.vendor}|${device.kind}`;
      const counts = byDevice.get(device.id);
      const entry = grouped.get(key) ?? {
        vendor: device.vendor,
        kind: device.kind,
        count: 0,
        metersPower: false,
        readings: 0,
      };
      entry.count += 1;
      entry.readings += counts?._all ?? 0;
      // A device counts as metering only if it has actually produced a watt figure —
      // a Kasa switch without an energy monitor looks identical until you look.
      if ((counts?.powerW ?? 0) > 0) entry.metersPower = true;
      grouped.set(key, entry);
    }

    /*
      The gateway is the yardstick: if it is configured then it is reachable, so it is
      definitely on the network the owner wants scanned.
    */
    const reach = assessDiscoveryReach(
      Object.values(os.networkInterfaces()).flat().filter((i): i is os.NetworkInterfaceInfo => Boolean(i)),
      await this.setting(DTU_HOST_SETTING),
    );

    const hstRaw = Number(await this.setting('hstRate'));
    const hst = Number.isFinite(hstRaw) && hstRaw > 0 && hstRaw < 1 ? hstRaw : 0;
    const program = resolveProgram((await this.setting('rewardProgramId')) ?? 'net-metering', {
      taxRate: hst,
      // A nominal 1.0 so the programme resolves; no price reaches the report.
      retailPerKwh: 1,
    });
    const selfPct = Number(await this.setting('selfConsumptionPct'));

    const dates = days.map((d) => d.localDate).sort();
    const vendor = INVERTER_VENDORS[vendorId ?? DEFAULT_VENDOR];

    return {
      version: describeBuild(),
      generatedAt: new Date().toISOString(),
      ...this.zoneShape(),
      solarVendorName: vendor?.name ?? null,
      chargerVendorName: chargerHost ? CHARGER_VENDORS[DEFAULT_CHARGER_VENDOR].name : null,
      vehicleSourceName: vehicleRows ? VEHICLE_SOURCES[DEFAULT_VEHICLE_SOURCE].name : null,
      pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || null,
      census,
      portsPerInverter,
      production: {
        daysObserved: days.length,
        lifetimeKwh,
        bestDayKwh: bestDay._max.dailyEnergy ? bestDay._max.dailyEnergy / 1000 : null,
        peakPowerW: peakSystem._max.totalPower ?? null,
        peakPerPanelW: peakPanel._max.power ?? null,
        firstDate: dates[0] ?? null,
        lastDate: dates[dates.length - 1] ?? null,
      },
      devices: [...grouped.values()].sort((a, b) => a.vendor.localeCompare(b.vendor)),
      // Only the flag. The reason names addresses and belongs on screen, not in a file
      // meant to be pasted in public.
      discovery: { onDeviceSubnet: reach.onDeviceSubnet },
      alerts,
      collectionGaps: await this.collectionGaps(),
      tariff: {
        programName: program.name,
        // Expressed against a retail price of 1, so this is the ratio and never a price.
        selfConsumptionPremium: hst > 0 ? hst / (1 + hst) : null,
        priceIncludesTax: (await this.setting('priceIncludesTax')) !== '0',
        selfConsumptionPct: Number.isFinite(selfPct) && selfPct > 0 ? selfPct : null,
        selfConsumptionEstimated: Number.isFinite(selfPct) && selfPct > 0,
      },
    };
  }

  async markdown(): Promise<string> {
    return buildReportMarkdown(await this.build());
  }
}
