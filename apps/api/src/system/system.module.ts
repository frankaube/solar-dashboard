import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EvccModule } from '../evcc/evcc.module';
import { ArrayCensusService } from './array-census.service';
import { ReportService } from './report.service';
import { SourcesService } from './sources.service';
import { SystemController } from './system.controller';

@Module({
  imports: [PrismaModule, EvccModule],
  controllers: [SystemController],
  providers: [ArrayCensusService, ReportService, SourcesService],
  // Exported for the alert engine, with no path back to the collector — that is circular.
  exports: [ArrayCensusService, ReportService],
})
export class SystemModule {}
