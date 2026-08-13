import { Module } from '@nestjs/common';
import { ChargerModule } from '../charger/charger.module';
import { CollectorModule } from '../collector/collector.module';
import { DevicesModule } from '../devices/devices.module';
import { DiscoveryService } from './discovery.service';
import { OnboardingController } from './onboarding.controller';
import { SetupController } from './setup.controller';

@Module({
  imports: [CollectorModule, ChargerModule, DevicesModule],
  controllers: [SetupController, OnboardingController],
  providers: [DiscoveryService],
})
export class SetupModule {}
