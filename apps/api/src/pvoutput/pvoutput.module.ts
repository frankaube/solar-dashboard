import { Module } from '@nestjs/common';
import { CollectorModule } from '../collector/collector.module';
import { PvoutputController } from './pvoutput.controller';
import { PvoutputService } from './pvoutput.service';

@Module({
  imports: [CollectorModule],
  controllers: [PvoutputController],
  providers: [PvoutputService],
  exports: [PvoutputService],
})
export class PvoutputModule {}
