import { Controller, Get } from '@nestjs/common';
import { OcppService } from './ocpp.service';

@Controller('ocpp')
export class OcppController {
  constructor(private readonly ocpp: OcppService) {}

  /** Whether the central system is listening, and every charge point that has dialled in. */
  @Get('status')
  status(): object {
    return this.ocpp.status();
  }
}
