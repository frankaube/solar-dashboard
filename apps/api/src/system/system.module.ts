import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EvccModule } from '../evcc/evcc.module';
import { ArrayCensusService } from './array-census.service';
import { ReportService } from './report.service';
import { SystemController } from './system.controller';

@Module({
  imports: [PrismaModule, EvccModule],
  controllers: [SystemController],
  providers: [ArrayCensusService, ReportService],
  // Exported so the alert engine can raise the serious findings without importing the
  // controller — and with no path back to the collector, which would be circular.
  exports: [ArrayCensusService, ReportService],
})
export class SystemModule {}
