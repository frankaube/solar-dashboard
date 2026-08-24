import { Controller, Get } from '@nestjs/common';
import { EvccService } from './evcc.service';

@Controller('evcc')
export class EvccController {
  constructor(private readonly evcc: EvccService) {}

  /** Summary for the UI: is it connected, and what does it currently see. */
  @Get('status')
  status(): object {
    return this.evcc.status();
  }

  /** Everything parsed, for debugging a mapping against a real instance. */
  @Get('state')
  state(): object {
    return { state: this.evcc.current() };
  }
}
