import { Module } from '@nestjs/common';
import { SystemModule } from '../system/system.module';
import { WeatherModule } from '../weather/weather.module';
import { AlertsController } from './alerts.controller';
import { NotificationsController } from './notifications.controller';
import { AlertsService } from './alerts.service';
import { NotifierService } from './notifier.service';

@Module({
  imports: [WeatherModule, SystemModule],
  controllers: [AlertsController, NotificationsController],
  providers: [AlertsService, NotifierService],
  exports: [AlertsService, NotifierService],
})
export class AlertsModule {}
