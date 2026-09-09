import { BadRequestException, Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { UpdateService, UpdateStatus } from './update.service';

@Controller('updates')
export class UpdateController {
  constructor(private readonly updates: UpdateService) {}

  @Get()
  status(): Promise<UpdateStatus> {
    return this.updates.status();
  }

  @Post('check')
  async checkNow(): Promise<UpdateStatus> {
    await this.updates.check();
    return this.updates.status();
  }

  @Put('policy')
  async savePolicy(
    @Body() body: { channel?: string; apply?: boolean; hour?: number },
  ): Promise<UpdateStatus> {
    await this.updates.savePolicy(body ?? {});
    return this.updates.status();
  }

  /**
   * Queue an install of a named version. The version is required — it is what the user
   * consented to, and "install the latest" could differ from that. A refusal is 200 ok:false.
   */
  @Post('install')
  async install(@Body() body: { version?: string }): Promise<{ ok: boolean; message: string }> {
    if (!body?.version) throw new BadRequestException('version is required');
    return this.updates.requestInstall(body.version);
  }

  @Delete('install')
  async cancel(): Promise<{ ok: true }> {
    await this.updates.cancelInstall();
    return { ok: true };
  }
}
