import { Module } from '@nestjs/common';
import { ChargerController } from './charger.controller';
import { ChargerService } from './charger.service';
import { TeslamateService } from './teslamate.service';

@Module({
  controllers: [ChargerController],
  providers: [ChargerService, TeslamateService],
  exports: [ChargerService],
})
export class ChargerModule {}
