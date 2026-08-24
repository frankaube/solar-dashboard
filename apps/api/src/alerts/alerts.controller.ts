import { Controller, Get, Param, ParseIntPipe, Put } from '@nestjs/common';
import { AlertsService } from './alerts.service';

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  getAlerts(): object {
    return this.alerts.getAlerts();
  }

  @Put(':id/ack')
  async acknowledge(@Param('id', ParseIntPipe) id: number): Promise<object> {
    await this.alerts.acknowledge(id);
    return { id, acknowledged: true };
  }
}
