import { Controller, Get, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CollectorService } from '../collector/collector.service';
import { ChargerService } from '../charger/charger.service';
import { suggestedSubnets } from './subnet';

const ONBOARDING_SETTING = 'onboardingComplete';
const PRICE_SETTING = 'electricityPricePerKwh';
const NOTIFY_SETTING = 'notifyWebhookUrl';

@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collector: CollectorService,
    private readonly charger: ChargerService,
  ) {}

  @Get('status')
  async status(): Promise<object> {
    const collectorStatus = this.collector.getStatus() as {
      dtuHost: string | null;
      reportingInverterCount: number | null;
    };
    const [deviceCount, price, notify, complete] = await Promise.all([
      this.prisma.device.count(),
      this.prisma.setting.findUnique({ where: { key: PRICE_SETTING } }),
      this.prisma.setting.findUnique({ where: { key: NOTIFY_SETTING } }),
      this.prisma.setting.findUnique({ where: { key: ONBOARDING_SETTING } }),
    ]);

    const solarConfigured = Boolean(collectorStatus.dtuHost);
    return {
      // An already-adopted solar gateway means an existing/migrated install that
      // predates the wizard — don't force those users through setup.
      complete: complete?.value === 'true' || solarConfigured,
      // The dashboard is usable the moment a solar gateway is adopted.
      solar: {
        configured: solarConfigured,
        host: collectorStatus.dtuHost,
        inverterCount: collectorStatus.reportingInverterCount,
      },
      charger: { configured: Boolean(this.charger.getHost()), host: this.charger.getHost() },
      devices: { count: deviceCount },
      preferences: { priceSet: Boolean(price), notifySet: Boolean(notify) },
      suggestedSubnet: suggestedSubnets({ configuredHosts: [collectorStatus.dtuHost] })[0],
      subnetSuggestions: suggestedSubnets({ configuredHosts: [collectorStatus.dtuHost] }),
    };
  }

  @Post('complete')
  async complete(): Promise<object> {
    await this.prisma.setting.upsert({
      where: { key: ONBOARDING_SETTING },
      create: { key: ONBOARDING_SETTING, value: 'true' },
      update: { value: 'true' },
    });
    return { complete: true };
  }

  @Post('reset')
  async reset(): Promise<object> {
    await this.prisma.setting.upsert({
      where: { key: ONBOARDING_SETTING },
      create: { key: ONBOARDING_SETTING, value: 'false' },
      update: { value: 'false' },
    });
    return { complete: false };
  }
}
