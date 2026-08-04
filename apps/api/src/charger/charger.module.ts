import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChargerController } from './charger.controller';
import { VehicleController } from './vehicle.controller';
import { ChargerService } from './charger.service';
import { TeslamateService } from './teslamate.service';
import { FuelPriceService } from './fuel-price.service';

@Module({
  imports: [PrismaModule],
  controllers: [ChargerController, VehicleController],
  providers: [ChargerService, TeslamateService, FuelPriceService],
  exports: [ChargerService, TeslamateService, FuelPriceService],
})
export class ChargerModule {}
