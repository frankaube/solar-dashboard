import { BadRequestException, Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CollectorService, DTU_HOST_SETTING, SOLAR_VENDOR_SETTING } from '../collector/collector.service';
import { CHARGER_HOST_SETTING, ChargerService } from '../charger/charger.service';
import { INVERTER_VENDORS } from '../datasource/vendors';
import { DiscoveryService } from './discovery.service';
import { COMMON_SUBNETS, suggestedSubnets } from './subnet';

const HOST_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const DEFAULT_SUBNETS = COMMON_SUBNETS;

function subnetOf(host: string | null | undefined): string | null {
  if (!host || !HOST_PATTERN.test(host)) return null;
  return host.split('.').slice(0, 3).join('.');
}

@Controller('setup')
export class SetupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly discovery: DiscoveryService,
    private readonly collector: CollectorService,
    private readonly charger: ChargerService,
  ) {}

  @Get('devices')
  async getDevices(): Promise<object> {
    const status = this.collector.getStatus() as { dtuHost: string | null };
    const suggestedSubnet =
      suggestedSubnets({ configuredHosts: [status.dtuHost, this.charger.getHost()] })[0] ??
      DEFAULT_SUBNETS[0];
    return {
      dtuHost: status.dtuHost,
      chargerHost: this.charger.getHost(),
      suggestedSubnet,
      vendors: Object.values(INVERTER_VENDORS).map((vendor) => ({
        id: vendor.id,
        name: vendor.name,
      })),
    };
  }

  @Post('scan')
  async scan(@Query('subnet') subnet?: string): Promise<object> {
    const prefix = subnet?.trim() || DEFAULT_SUBNETS[0];
    try {
      return await this.discovery.scan(prefix);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Put('devices')
  async putDevices(
    @Body() body: { dtuHost?: unknown; chargerHost?: unknown; solarVendor?: unknown },
  ): Promise<object> {
    const parse = (raw: unknown, name: string): string | null => {
      if (raw === undefined || raw === null || raw === '') return null;
      const value = String(raw).trim();
      if (!HOST_PATTERN.test(value)) {
        throw new BadRequestException(`${name} must be an IPv4 address`);
      }
      return value;
    };
    const dtuHost = parse(body.dtuHost, 'dtuHost');
    const chargerHost = parse(body.chargerHost, 'chargerHost');
    const vendor =
      body.solarVendor && INVERTER_VENDORS[String(body.solarVendor)]
        ? String(body.solarVendor)
        : undefined;
    if (!dtuHost && !chargerHost) throw new BadRequestException('Nothing to update');

    if (dtuHost) {
      await this.prisma.setting.upsert({
        where: { key: DTU_HOST_SETTING },
        create: { key: DTU_HOST_SETTING, value: dtuHost },
        update: { value: dtuHost },
      });
      if (vendor) {
        await this.prisma.setting.upsert({
          where: { key: SOLAR_VENDOR_SETTING },
          create: { key: SOLAR_VENDOR_SETTING, value: vendor },
          update: { value: vendor },
        });
      }
      this.collector.applyHost(dtuHost, vendor);
    }
    if (chargerHost) {
      await this.prisma.setting.upsert({
        where: { key: CHARGER_HOST_SETTING },
        create: { key: CHARGER_HOST_SETTING, value: chargerHost },
        update: { value: chargerHost },
      });
      this.charger.applyHost(chargerHost);
    }
    return this.getDevices();
  }
}
