import { Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { PvoutputService } from './pvoutput.service';

/** The key goes in and never comes back out: `status()` reports only whether one is stored. */
@Controller('pvoutput')
export class PvoutputController {
  constructor(private readonly pvoutput: PvoutputService) {}

  @Get()
  status(): Promise<object> {
    return this.pvoutput.status();
  }

  @Put()
  async save(
    @Body() body: { enabled?: unknown; apiKey?: unknown; systemId?: unknown },
  ): Promise<object> {
    await this.pvoutput.save({
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      apiKey: body.apiKey === undefined ? undefined : String(body.apiKey),
      systemId: body.systemId === undefined ? undefined : String(body.systemId),
    });
    return this.pvoutput.status();
  }

  /** Send one status now, so the owner can see whether it actually lands. */
  @Post('test')
  test(): Promise<object> {
    return this.pvoutput.testUpload();
  }

  @Delete()
  async forget(): Promise<object> {
    await this.pvoutput.forget();
    return this.pvoutput.status();
  }
}
