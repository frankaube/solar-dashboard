import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { EvccController } from './evcc.controller';
import { EvccService } from './evcc.service';

@Module({
  imports: [IntegrationsModule],
  controllers: [EvccController],
  providers: [EvccService],
  exports: [EvccService],
})
export class EvccModule {}
