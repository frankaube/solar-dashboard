import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { DevicesService } from './devices.service';
import {
  MANUAL_VENDORS,
  defaultName,
  findManualVendor,
  probePort,
  validHost,
} from './manual-add';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list(): object {
    return this.devices.list();
  }

  /** Comma-separated for several: `?subnet=192.168.1,10.0.0`. */
  @Post('scan')
  scan(@Query('subnet') subnet?: string): object {
    if (!subnet) throw new BadRequestException('subnet is required');
    const prefixes = subnet
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.devices.scan(prefixes);
  }

  /**
   * Where it is worth scanning, ranked, with a reason for each.
   *
   * Gateway addresses come from env rather than by injecting CollectorService and
   * ChargerService — those live in modules this one does not import, and reaching for
   * them to read two strings would buy a dependency cycle for nothing.
   */
  @Get('subnets')
  suggestions(): object {
    return this.devices.subnetSuggestions([
      process.env.DTU_HOST ?? null,
      process.env.CHARGER_HOST ?? null,
    ]);
  }

  @Post('adopt')
  adopt(
    @Body()
    body: { vendor?: string; kind?: string; name?: string; host?: string; port?: number; hardwareId?: string },
  ): object {
    for (const field of ['vendor', 'kind', 'name', 'host'] as const) {
      if (!body[field]) throw new BadRequestException(`${field} is required`);
    }
    return this.devices.adopt({
      vendor: String(body.vendor),
      kind: String(body.kind),
      name: String(body.name),
      host: String(body.host),
      port: body.port,
      hardwareId: body.hardwareId,
    });
  }

  /** What can be added by typing an address, and what each one needs. */
  @Get('manual-vendors')
  manualVendors(): object {
    return MANUAL_VENDORS;
  }

  /**
   * Add a device by address, for the ones discovery cannot hear.
   *
   * Discovery and reachability are separate problems. A Tuya plug broadcasts its presence
   * over UDP, which a bridged container never receives — but TCP to the same address from
   * the same container connects immediately, because unicast is routed. The device was
   * always reachable and never findable, so typing the address in is a real fix.
   */
  @Post('manual')
  async addManually(
    @Body() body: { vendor?: string; host?: string; name?: string; credential?: string },
  ): Promise<object> {
    const vendor = findManualVendor(String(body?.vendor ?? ''));
    if (!vendor) throw new BadRequestException('Unknown vendor');
    const host = String(body?.host ?? '').trim();
    if (!validHost(host)) throw new BadRequestException('That does not look like an address');

    /*
      Probed before adopting. Adding an unreachable address would leave a device in the
      list that never reports anything, which is indistinguishable from the bug this
      feature exists to fix.
    */
    const reachable = await probePort(host, vendor.port);
    if (!reachable) {
      throw new BadRequestException(
        `Nothing answered on ${host}:${vendor.port}. Check the address, and that this machine can reach that network.`,
      );
    }

    const device = await this.devices.adopt({
      vendor: vendor.id,
      kind: vendor.kind,
      name: String(body?.name ?? '').trim() || defaultName(vendor, host),
      host,
      port: vendor.port,
    });
    if (body?.credential) {
      await this.devices.setCredential(
        Number((device as { id: number }).id),
        'localKey',
        String(body.credential),
      );
    }
    return {
      device,
      // Said plainly, because a plug that is present but unreadable otherwise looks broken.
      readable: vendor.readableWithoutCredentials || Boolean(body?.credential),
      note: vendor.note,
    };
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; room?: string | null; critical?: boolean; enabled?: boolean },
  ): object {
    return this.devices.update(id, body);
  }

  /**
   * Declare that this meter is clamped on the service entrance: `{ role: "mains" }`.
   * `{ role: null }` clears it.
   *
   * The one designation that changes how a device's readings are used elsewhere. With it,
   * self-consumption stops being a percentage the owner typed in and becomes production
   * minus what actually left the property — so the whole savings page moves from estimate
   * to measurement. Without it every device is just itself.
   */
  @Put(':id/role')
  setRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { role?: unknown },
  ): Promise<object> {
    const raw = body.role;
    if (raw !== null && raw !== 'mains') {
      throw new BadRequestException('role must be "mains" or null');
    }
    return this.devices.setRole(id, raw);
  }

  /**
   * Say what a device runs, for hardware that cannot measure itself:
   * `{ loadLabel: "Pool pump", ratedW: 1100, loadType: "motor" }`.
   * Pass null to clear a field.
   */
  @Put(':id/load')
  setLoad(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { ratedW?: number | null; loadLabel?: string | null; loadType?: string | null },
  ): object {
    return this.devices.setLoad(id, body);
  }

  /**
   * Name a meter's circuits and declare their wiring:
   * `[{ channel: 1, label: "Mini splits", ratedW: 3000, voltageMultiplier: 2 }]`.
   * `voltageMultiplier: 2` is required for a 240 V two-pole circuit clamped on one
   * leg — without it the circuit reads half.
   */
  @Put(':id/channels')
  setChannels(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      channels?: Array<{
        channel: number;
        label?: string;
        ratedW?: number;
        voltageMultiplier?: number;
      }>;
    },
  ): object {
    if (!Array.isArray(body.channels) || body.channels.length === 0) {
      throw new BadRequestException('channels must be a non-empty array');
    }
    return this.devices.setChannels(id, body.channels);
  }

  @Post(':id/command')
  async command(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { action?: string; value?: number },
  ): Promise<object> {
    if (!body.action) throw new BadRequestException('action is required');
    // Hand back the state read from the device after the change, so a caller can
    // render the result without a follow-up request that would race the poll loop.
    const state = await this.devices.command(id, body.action, body.value);
    return { ok: true, state };
  }

  @Post(':id/pair')
  async pair(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { pin?: string },
  ): Promise<object> {
    if (!body.pin) throw new BadRequestException('pin is required (XXX-XX-XXX)');
    await this.devices.pairHomeKit(id, body.pin);
    return { ok: true };
  }

  @Get('usage')
  usage(@Query('days') days?: string): object {
    const parsed = Number(days ?? 7);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 90) {
      throw new BadRequestException('days must be between 1 and 90');
    }
    return this.devices.getUsage(parsed);
  }

  @Get(':id/schedules')
  schedules(@Param('id', ParseIntPipe) id: number): object {
    return this.devices.listSchedules(id);
  }

  @Post(':id/schedules')
  addSchedule(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { action?: string; trigger?: string; timeOfDay?: string; offsetMin?: number; value?: number },
  ): object {
    if (!body.action || !body.trigger) {
      throw new BadRequestException('action and trigger are required');
    }
    return this.devices.addSchedule(id, {
      action: body.action,
      trigger: body.trigger,
      timeOfDay: body.timeOfDay,
      offsetMin: body.offsetMin,
      value: body.value,
    });
  }

  @Delete('schedules/:scheduleId')
  removeSchedule(@Param('scheduleId', ParseIntPipe) scheduleId: number): object {
    return this.devices.removeSchedule(scheduleId);
  }
}
