import { Body, Controller, Get, Put } from '@nestjs/common';
import { MdnsService, MdnsStatus } from './mdns.service';

/**
 * The `.local` name, readable and changeable.
 *
 * Renaming is the one setting in the app that can cut off the browser making the request,
 * so the response carries the new URL and the LAN address together — whatever happens to
 * the name, there is always a way back in.
 */
@Controller('mdns')
export class MdnsController {
  constructor(private readonly mdns: MdnsService) {}

  @Get()
  status(): MdnsStatus {
    return this.mdns.status();
  }

  @Put()
  rename(@Body() body: { hostname?: unknown }): Promise<MdnsStatus> {
    return this.mdns.rename(String(body?.hostname ?? ''));
  }
}
