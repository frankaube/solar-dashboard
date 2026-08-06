import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UpdateController } from './update.controller';
import { UpdateService } from './update.service';

@Module({
  imports: [PrismaModule],
  controllers: [UpdateController],
  providers: [UpdateService],
})
export class UpdatesModule {}
