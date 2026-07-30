import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ChargerService } from './charger.service';
import { TeslamateService } from './teslamate.service';

const DEFAULT_HISTORY_HOURS = 24;
const MAX_HISTORY_HOURS = 24 * 31;

@Controller('charger')
export class ChargerController {
  constructor(
    private readonly charger: ChargerService,
    private readonly teslamate: TeslamateService,
  ) {}

  @Get()
  async getLive(): Promise<object> {
    return { live: this.charger.getLive(), vehicle: await this.teslamate.getVehicle() };
  }

  @Get('vehicle')
  async getVehicleDetails(@Query('days') days?: string): Promise<object> {
    const parsed = Number(days ?? 30);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 366) {
      throw new BadRequestException('days must be between 1 and 366');
    }
    return { details: await this.teslamate.getDetails(parsed) };
  }

  @Get('sessions')
  getSessions(@Query('days') days?: string): object {
    const parsed = Number(days ?? 30);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 366) {
      throw new BadRequestException('days must be between 1 and 366');
    }
    return this.charger.getSessions(parsed);
  }

  @Get('history')
  getHistory(@Query('hours') hours?: string): object {
    const parsed = Number(hours ?? DEFAULT_HISTORY_HOURS);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_HISTORY_HOURS) {
      throw new BadRequestException(`hours must be between 1 and ${MAX_HISTORY_HOURS}`);
    }
    return this.charger.getHistory(parsed);
  }
}
