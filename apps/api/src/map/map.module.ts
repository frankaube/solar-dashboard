import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TilesController } from './tiles.controller';
import { TilesService } from './tiles.service';

@Module({
  imports: [PrismaModule],
  controllers: [TilesController],
  providers: [TilesService],
  exports: [TilesService],
})
export class MapModule {}
