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

  /** What the app can connect to, and what each one needs. The page renders from this. */
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

  /** Try a configuration without storing it. A failed connection is 200 with `ok: false`, not a 4xx. */
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
    await this.battery.saveVendorConfig(body.vendor, body.config ?? {});
    return this.battery.getConfig();
  }

  @Delete('config')
  async deleteConfig(): Promise<object> {
    await this.battery.clearConfig();
    return this.battery.getConfig();
  }
}
