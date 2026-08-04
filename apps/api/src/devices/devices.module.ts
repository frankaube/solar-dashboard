import { Module } from '@nestjs/common';
import { WeatherModule } from '../weather/weather.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [WeatherModule],
  controllers: [DevicesController],
  providers: [DevicesService, SchedulerService],
  exports: [DevicesService],
})
export class DevicesModule {}
