import { Module } from '@nestjs/common';
import { OcppController } from './ocpp.controller';
import { OcppService } from './ocpp.service';

@Module({
  controllers: [OcppController],
  providers: [OcppService],
  exports: [OcppService],
})
export class OcppModule {}
