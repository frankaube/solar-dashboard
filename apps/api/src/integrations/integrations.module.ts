import { Module } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { HaDiscoveryService } from './ha-discovery.service';

@Module({
  providers: [MqttService, HaDiscoveryService],
  exports: [MqttService, HaDiscoveryService],
})
export class IntegrationsModule {}
