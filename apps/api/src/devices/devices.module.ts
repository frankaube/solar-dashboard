import { Module } from '@nestjs/common';
import { WeatherModule } from '../weather/weather.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { MdnsController } from './mdns.controller';
import { MdnsService } from './mdns.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [WeatherModule],
  controllers: [DevicesController, MdnsController],
  providers: [DevicesService, MdnsService, SchedulerService],
  exports: [DevicesService, MdnsService],
})
export class DevicesModule {}
