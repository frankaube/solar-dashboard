import { BadRequestException, Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { UpdateService, UpdateStatus } from './update.service';

@Controller('updates')
export class UpdateController {
  constructor(private readonly updates: UpdateService) {}

  @Get()
  status(): Promise<UpdateStatus> {
    return this.updates.status();
  }

  /** Look now rather than waiting for the next tick. Returns the whole status, not a diff. */
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
   * Queue an install of a named version.
   *
   * The version is required and is not a formality: it is what the user saw on screen and
   * consented to. Accepting "install the latest" would mean the thing installed could
   * differ from the thing agreed to, and this endpoint's whole job is to carry that
   * consent to a process running as root.
   *
   * A refusal returns 200 with ok:false. The request was well formed; "that is not the
   * release on offer" is the useful answer.
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
