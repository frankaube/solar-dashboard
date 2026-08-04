import { BadRequestException, Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { BatteryService } from './battery.service';
import { batteryVendorCatalogue, findBatteryVendor } from './vendors';

@Controller('battery')
export class BatteryController {
  constructor(private readonly battery: BatteryService) {}

  @Get()
  getState(): Promise<object> {
    return this.battery.getState();
  }

  @Get('config')
  getConfig(): Promise<object> {
    return this.battery.getConfig();
  }

  /**
   * What the app can connect to, and what each one needs.
   *
   * The page renders from this rather than hardcoding one vendor's form, so adding a
   * battery is a registry entry rather than a UI change.
   */
  @Get('vendors')
  vendors(): object {
    return batteryVendorCatalogue();
  }

  @Post('ecoflow/devices')
  async devices(@Body() body: { accessKey?: string; secretKey?: string }): Promise<object> {
    if (!body.accessKey || !body.secretKey) {
      throw new BadRequestException('accessKey and secretKey are required');
    }
    try {
      return { devices: await this.battery.listEcoFlowDevices(body.accessKey, body.secretKey) };
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /**
   * Try a configuration without storing it.
   *
   * Returns 200 with `ok: false` rather than a 4xx for a failed connection: the request
   * was well formed and the answer — "that address does not respond" — is the useful
   * result, not an error the client has to dig out of an exception body.
   */
  @Post('test')
  async test(
    @Body() body: { vendor?: string; config?: Record<string, string> },
  ): Promise<object> {
    if (!body.vendor) throw new BadRequestException('vendor is required');
    return this.battery.testConfig(body.vendor, body.config ?? {});
  }

  @Put('config')
  async putConfig(
    @Body() body: { vendor?: string; config?: Record<string, string> },
  ): Promise<object> {
    if (!body.vendor) throw new BadRequestException('vendor is required');
    const vendor = findBatteryVendor(body.vendor);
    if (!vendor) throw new BadRequestException(`Unknown battery vendor: ${body.vendor}`);
    /*
      Checked against the registry, not stored as free text: the id selects which client
      gets built, so an unrecognised one would leave the owner with a battery page that
      looks configured and never reads anything.
    */
    await this.battery.saveVendorConfig(body.vendor, body.config ?? {});
    return this.battery.getConfig();
  }

  @Delete('config')
  async deleteConfig(): Promise<object> {
    await this.battery.clearConfig();
    return this.battery.getConfig();
  }
}
