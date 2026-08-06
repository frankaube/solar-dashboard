import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { ChargerModule } from '../charger/charger.module';
import { CollectorModule } from '../collector/collector.module';
import { WeatherModule } from '../weather/weather.module';
import { DailySummaryService } from '../alerts/daily-summary.service';
import { AnalyticsService } from './analytics.service';
import { RateHistoryController } from './rate-history.controller';
import { CreditBankController } from './credit-bank.controller';
import { CreditBankService } from './credit-bank.service';
import { CloudImportController } from './cloud-import.controller';
import { CloudImportService } from './cloud-import.service';
import { DegradationService } from './degradation.service';
import { MetricsController } from './metrics.controller';
import { ReadingsController } from './readings.controller';
import { ReadingsService } from './readings.service';
import { SavingsService } from './savings.service';
import { UtilityImportService } from './utility-import.service';

@Module({
  imports: [CollectorModule, AlertsModule, WeatherModule, ChargerModule],
  controllers: [
    ReadingsController,
    MetricsController,
    CreditBankController,
    RateHistoryController,
    CloudImportController,
  ],
  providers: [
    ReadingsService,
    AnalyticsService,
    DailySummaryService,
    SavingsService,
    CreditBankService,
    DegradationService,
    UtilityImportService,
    CloudImportService,
  ],
})
export class ReadingsModule {}
