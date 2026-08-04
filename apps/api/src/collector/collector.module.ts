import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { CollectorService } from './collector.service';

@Module({
  imports: [AlertsModule, IntegrationsModule],
  providers: [CollectorService],
  exports: [CollectorService],
})
export class CollectorModule {}
