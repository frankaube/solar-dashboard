import { Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { PvoutputService } from './pvoutput.service';

/**
 * Settings for the one outbound integration.
 *
 * The key goes in and never comes back out — `status()` reports whether one is stored, not
 * what it is. A settings endpoint that echoes a secret puts it in a response body, a proxy
 * log and a browser cache, none of which needed it.
 */
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
