import { Module } from '@nestjs/common';
import { WeatherController } from './weather.controller';
import { WeatherService } from './weather.service';
import { RadarController } from './radar.controller';
import { RadarService } from './radar.service';

@Module({
  controllers: [WeatherController, RadarController],
  providers: [WeatherService, RadarService],
  exports: [WeatherService],
})
export class WeatherModule {}
