import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChargerController } from './charger.controller';
import { VehicleController } from './vehicle.controller';
import { ChargerService } from './charger.service';
import { TeslamateService } from './teslamate.service';

@Module({
  imports: [PrismaModule],
  controllers: [ChargerController, VehicleController],
  providers: [ChargerService, TeslamateService],
  exports: [ChargerService, TeslamateService],
})
export class ChargerModule {}
