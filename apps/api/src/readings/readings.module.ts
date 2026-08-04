import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { ChargerModule } from '../charger/charger.module';
import { CollectorModule } from '../collector/collector.module';
import { WeatherModule } from '../weather/weather.module';
import { DailySummaryService } from '../alerts/daily-summary.service';
import { AnalyticsService } from './analytics.service';
import { CreditBankController } from './credit-bank.controller';
import { CreditBankService } from './credit-bank.service';
import { MetricsController } from './metrics.controller';
import { ReadingsController } from './readings.controller';
import { ReadingsService } from './readings.service';
import { SavingsService } from './savings.service';

@Module({
  imports: [CollectorModule, AlertsModule, WeatherModule, ChargerModule],
  controllers: [ReadingsController, MetricsController, CreditBankController],
  providers: [ReadingsService, AnalyticsService, DailySummaryService, SavingsService, CreditBankService],
})
export class ReadingsModule {}
