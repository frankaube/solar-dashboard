import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Device } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KasaAdapter } from './kasa.adapter';
import { MysaAdapter, pairMysa } from './mysa.adapter';
import { ShellyAdapter } from './shelly.adapter';
import { HomeKitAdapter } from './homekit.adapter';
import { TasmotaAdapter } from './tasmota.adapter';
import { EsphomeAdapter } from './esphome.adapter';
import { DaikinAdapter } from './daikin.adapter';
import { correctChannelEnergy } from './metering';
import { localDateOf } from '../common/localdate';
import {
  Confidence,
  LOAD_TYPES,
  LoadType,
  estimateFromOnTime,
  sumDailyMaxima,
  readLoadConfig,
} from './load-estimate';
import { DeviceAdapter, DeviceState } from './types';
import { DISCOVERY_PROBES } from './discovery/probes';
import { NetworkScanner } from './discovery/scanner';
import { ScanResult } from './discovery/types';
import { SubnetSuggestion, subnetSuggestions } from '../setup/subnet';
import * as net from 'node:net';

const POLL_INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 15 * 60_000;
const MAX_USAGE_GAP_MS = 20 * 60_000;
const STANDBY_W = 1;
const STANDBY_SHARE = 0.2;
const LONG_ON_HOURS = 10;
/**
 * How long to wait for a TCP connect during a sweep.
 *
 * Only ever elapses on empty addresses: a device on the same LAN answers in single-digit
 * milliseconds and a present host with the port shut refuses immediately, so this is paid
 * on each of the ~250 addresses where nothing is listening. 700 ms still leaves a hundred
 * LAN round trips of headroom for an embedded device slow to accept.
 */
const CONNECT_TIMEOUT_MS = 700;
/** Hot legs a single CT can be missing: 1 (none), 2 (split-phase 240 V), 3 (three-phase). */
const VALID_MULTIPLIERS = new Set([1, 2, 3]);

/** Per-circuit settings stored in a meter's config JSON, keyed by channel number. */
interface ChannelConfig {
  label?: string;
  ratedW?: number;
  /**
   * A CT on ONE leg of a 240 V two-pole circuit, referenced to a 120 V line input, reports
   * exactly half the true power. Doubling is exact, not approximate: on split-phase the
   * line-to-line voltage is in phase with line-to-neutral and twice its magnitude, so it
   * holds for a reactive load such as an inverter mini split too.
   *
   * Shelly exposes no doubling setting (channel config takes only `name`, `reverse`,
   * `ct_type`, `alarms`), so the correction lives here. Applied on read, never on write, so
   * fixing a mis-set multiplier corrects history instead of leaving a step in the data.
   */
  voltageMultiplier?: number;
}

export interface DeviceUsageDto {
  deviceId: number;
  name: string;
  kind: string;
  onHoursPerDay: number;
  energyKwh: number | null;
  metered: boolean;
  /** True when energyKwh is inferred from duty cycle x a rated wattage, not measured. */
  estimated?: boolean;
  /** How far to trust an estimate; absent when the figure was measured. */
  confidence?: Confidence;
  /** What the owner said this device runs — "Pool pump". */
  loadLabel?: string;
  /** Hours the thermostat actually called for heat, over the window. */
  heatingHours?: number;
  /** Energy sent back (meters only) — kept apart from consumption, never netted. */
  returnedKwh?: number;
  /** Per-circuit breakdown on a multi-channel meter — the appliance-level view. */
  channels?: ChannelUsageDto[];
  observations: string[];
}

export interface ChannelUsageDto {
  channel: number;
  /** Owner-supplied name for what this circuit feeds ("Dryer", "Water heater"). */
  label: string;
  energyKwh: number;
  returnedKwh?: number;
  /** Share of the device's total draw over the window — what's actually costing you. */
  sharePct: number;
  /** Echoed when != 1, so the UI can show the reading was corrected rather than measured. */
  voltageMultiplier?: number;
}

@Injectable()
export class DevicesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DevicesService.name);
  private readonly adapters = new Map<string, DeviceAdapter>();
  private readonly live = new Map<number, DeviceState & { updatedAt: string }>();
  private readonly lastStored = new Map<number, { at: number; key: string }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {
    for (const adapter of [
      new KasaAdapter(),
      new MysaAdapter(),
      new ShellyAdapter(),
      new TasmotaAdapter(),
      new EsphomeAdapter(),
      new DaikinAdapter(),
      new HomeKitAdapter(),
    ]) {
      this.adapters.set(adapter.vendor, adapter);
    }
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.pollAll(), POLL_INTERVAL_MS);
    void this.pollAll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async pollAll(): Promise<void> {
    const devices = await this.prisma.device.findMany({ where: { enabled: true } });
    for (const device of devices) {
      const adapter = this.adapters.get(device.vendor);
      if (!adapter) continue;
      try {
        const state = await adapter.poll(device);
        this.live.set(device.id, { ...state, updatedAt: new Date().toISOString() });
        const key = JSON.stringify([state.on, state.setpointC, state.heating, state.reachable]);
        const previous = this.lastStored.get(device.id);
        if (!previous || previous.key !== key || Date.now() - previous.at > HEARTBEAT_MS) {
          const takenAt = new Date();
          await this.prisma.deviceReading.create({
            data: {
              deviceId: device.id,
              takenAt,
              channel: 0, // the device as a whole
              on: state.on ?? null,
              powerW: state.powerW ?? null,
              energyWh: state.energyWh ?? null,
              energyTodayWh: state.energyTodayWh ?? null,
              energyReturnedWh: state.energyReturnedWh ?? null,
              temperatureC: state.temperatureC ?? null,
              setpointC: state.setpointC ?? null,
              heating: state.heating ?? null,
            },
          });
          // Multi-channel hardware also records each leg, sharing the timestamp so the rows
          // line up. Channel 0 above stays the whole-device total.
          if (state.channels?.length) {
            await this.prisma.deviceReading.createMany({
              data: state.channels.map((c) => ({
                deviceId: device.id,
                takenAt,
                channel: c.channel,
                powerW: c.powerW ?? null,
                energyWh: c.energyWh ?? null,
                energyReturnedWh: c.energyReturnedWh ?? null,
              })),
            });
          }
          this.lastStored.set(device.id, { at: Date.now(), key });
        }
      } catch (error) {
        this.logger.debug(`poll ${device.name}: ${(error as Error).message}`);
      }
    }
  }

  async list(): Promise<Array<Device & { state: (DeviceState & { updatedAt: string }) | null; capabilities: string[] }>> {
    const devices = await this.prisma.device.findMany({ orderBy: { name: 'asc' } });
    return devices.map((device) => {
      const adapter = this.adapters.get(device.vendor);
      const capabilities: string[] = [];
      if (adapter?.setOn) capabilities.push('setOn');
      if (adapter?.setTargetTemperature) capabilities.push('setTargetTemperature');
      return { ...device, state: this.live.get(device.id) ?? null, capabilities };
    });
  }

  /**
   * Find devices on the LAN. NetworkScanner plans the network work from the registered
   * probes; adding a vendor means writing one and registering it, see discovery/probes.ts.
   */
  async scan(subnetPrefixes: string[]): Promise<ScanResult> {
    if (subnetPrefixes.length === 0) throw new BadRequestException('at least one subnet is required');
    // Bounded: each subnet is 254 hosts per port.
    if (subnetPrefixes.length > 4) throw new BadRequestException('at most 4 subnets at a time');
    for (const prefix of subnetPrefixes) {
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) {
        throw new BadRequestException(`subnet must look like "192.168.1", got "${prefix}"`);
      }
    }
    const known = await this.prisma.device.findMany();
    const scanner = new NetworkScanner(DISCOVERY_PROBES, (host, port) => this.probe(host, port));
    const ctx = {
      isAdopted: (vendor: string, hardwareId?: string) =>
        known.some((d) => d.vendor === vendor && d.hardwareId === hardwareId),
    };
    // Sequential, not parallel: concurrent sweeps multiply the load on the network.
    const results: ScanResult[] = [];
    for (const prefix of subnetPrefixes) results.push(await scanner.scan(prefix, ctx));
    return {
      devices: results.flatMap((r) => r.devices),
      lookedFor: results[0]?.lookedFor ?? [],
      scanned: subnetPrefixes,
    };
  }

  /**
   * Where it is worth scanning, and why. Adopted device addresses are the strongest
   * evidence: our own interface inside Docker is a bridge, saying nothing about the LAN.
   */
  async subnetSuggestions(configuredHosts: Array<string | null>): Promise<SubnetSuggestion[]> {
    const devices = await this.prisma.device.findMany({ select: { host: true } });
    return subnetSuggestions({
      deviceHosts: devices.map((d) => d.host),
      configuredHosts,
    });
  }

  private probe(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (open: boolean): void => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
      socket.on('connect', () => done(true));
      socket.on('error', () => done(false));
    });
  }

  async adopt(input: {
    vendor: string;
    kind: string;
    name: string;
    host: string;
    port?: number;
    hardwareId?: string;
  }): Promise<Device> {
    return this.prisma.device.upsert({
      where: { vendor_hardwareId: { vendor: input.vendor, hardwareId: input.hardwareId ?? input.host } },
      create: {
        vendor: input.vendor,
        kind: input.kind,
        name: input.name,
        host: input.host,
        port: input.port ?? null,
        hardwareId: input.hardwareId ?? input.host,
      },
      update: { host: input.host, port: input.port ?? null },
    });
  }

  async update(
    id: number,
    patch: { name?: string; room?: string | null; critical?: boolean; enabled?: boolean },
  ): Promise<Device> {
    return this.prisma.device.update({ where: { id }, data: patch });
  }

  /**
   * Declare what a device runs and roughly what it draws — the only source of energy for a
   * switch-only plug. The load TYPE is stored too: a resistive heater and a variable-speed
   * pump yield estimates of very different quality from the same arithmetic.
   */
  /**
   * Mark a meter as the one clamped on the service entrance, or clear the mark.
   *
   * Exclusive, and enforced here: the previous holder is demoted in the same transaction,
   * so there is no instant with both or neither. Only a meter can hold it — a smart plug
   * would integrate to a plausible-looking export figure for one appliance.
   */
  async setRole(id: number, role: 'mains' | null): Promise<Device> {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('unknown device');
    if (role === 'mains' && device.kind !== 'meter') {
      throw new BadRequestException(
        `only a meter can be the mains — "${device.name}" is a ${device.kind}, and one appliance's power is not the property's`,
      );
    }
    const [, updated] = await this.prisma.$transaction([
      this.prisma.device.updateMany({
        where: { role: 'mains', id: { not: id } },
        data: { role: null },
      }),
      this.prisma.device.update({ where: { id }, data: { role } }),
    ]);
    return updated;
  }

  async setLoad(
    id: number,
    load: { ratedW?: number | null; loadLabel?: string | null; loadType?: string | null },
  ): Promise<Device> {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('unknown device');
    if (load.ratedW !== undefined && load.ratedW !== null) {
      if (!Number.isFinite(load.ratedW) || load.ratedW <= 0 || load.ratedW > 30_000) {
        throw new BadRequestException('ratedW must be between 1 and 30000');
      }
    }
    if (load.loadType !== undefined && load.loadType !== null && !LOAD_TYPES.includes(load.loadType as LoadType)) {
      throw new BadRequestException(`loadType must be one of: ${LOAD_TYPES.join(', ')}`);
    }
    let config: Record<string, unknown> = {};
    try {
      config = device.config ? (JSON.parse(device.config) as Record<string, unknown>) : {};
    } catch {
      config = {};
    }
    // null clears a field; undefined leaves it alone.
    for (const key of ['ratedW', 'loadLabel', 'loadType'] as const) {
      const value = load[key];
      if (value === undefined) continue;
      if (value === null || value === '') delete config[key];
      else config[key] = typeof value === 'string' ? value.trim() : value;
    }
    return this.prisma.device.update({ where: { id }, data: { config: JSON.stringify(config) } });
  }

  /**
   * Store a vendor credential in the device config, merging rather than replacing: the same
   * blob carries HomeKit pairing data, meter channel labels and load settings.
   */
  async setCredential(id: number, key: string, value: string): Promise<void> {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new BadRequestException(`No device ${id}`);
    let config: Record<string, unknown> = {};
    try {
      config = device.config ? (JSON.parse(device.config) as Record<string, unknown>) : {};
    } catch {
      config = {};
    }
    config[key] = value.trim();
    await this.prisma.device.update({ where: { id }, data: { config: JSON.stringify(config) } });
  }

  /**
   * Name a multi-channel meter's legs and, optionally, the wattage of what each feeds.
   * Stored in the device's config JSON rather than a new table; the shape is per-device.
   */
  async setChannels(
    id: number,
    channels: Array<{ channel: number; label?: string; ratedW?: number; voltageMultiplier?: number }>,
  ): Promise<Device> {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('unknown device');
    let config: Record<string, unknown> = {};
    try {
      config = device.config ? (JSON.parse(device.config) as Record<string, unknown>) : {};
    } catch {
      config = {}; // unparseable config is replaced, not merged into
    }
    const existing = (config.channels ?? {}) as Record<string, ChannelConfig | undefined>;
    for (const entry of channels) {
      if (!Number.isInteger(entry.channel) || entry.channel < 0) {
        throw new BadRequestException('channel must be a non-negative integer');
      }
      if (entry.ratedW !== undefined && !(entry.ratedW > 0)) {
        throw new BadRequestException('ratedW must be a positive number');
      }
      if (entry.voltageMultiplier !== undefined && !VALID_MULTIPLIERS.has(entry.voltageMultiplier)) {
        // An allow-list, not a range: the multiplier encodes how many hot legs the CT
        // missed. A free-form 1.7 would be a fudge factor, not a wiring fact.
        throw new BadRequestException('voltageMultiplier must be 1, 2, or 3');
      }
      const key = String(entry.channel);
      const prior = existing[key] ?? {};
      existing[key] = {
        ...prior,
        ...(entry.label !== undefined ? { label: entry.label.trim() || undefined } : {}),
        ...(entry.ratedW !== undefined ? { ratedW: entry.ratedW } : {}),
        ...(entry.voltageMultiplier !== undefined
          ? { voltageMultiplier: entry.voltageMultiplier }
          : {}),
      };
    }
    config.channels = existing;
    return this.prisma.device.update({
      where: { id },
      data: { config: JSON.stringify(config) },
    });
  }

  /**
   * Per-circuit energy for a multi-channel meter, ranked by consumption. Returns undefined
   * for single-channel hardware so the DTO stays clean for ordinary plugs.
   */
  private async channelUsage(
    device: Device,
    since: Date,
    deviceDrawnWh: number,
  ): Promise<ChannelUsageDto[] | undefined> {
    const rows = await this.prisma.deviceReading.findMany({
      where: { deviceId: device.id, channel: { gt: 0 }, takenAt: { gte: since } },
      orderBy: { takenAt: 'asc' },
      select: { takenAt: true, channel: true, powerW: true },
    });
    if (!rows.length) return undefined;

    const labels = this.channelLabels(device);
    const byChannel = new Map<number, { drawn: number; returned: number; last: number | null }>();
    for (const row of rows) {
      const acc = byChannel.get(row.channel) ?? { drawn: 0, returned: 0, last: null };
      if (acc.last !== null && row.powerW !== null) {
        const dtMs = Math.min(row.takenAt.getTime() - acc.last, MAX_USAGE_GAP_MS);
        // Same sign discipline as the device total: export is not negative consumption.
        if (row.powerW >= 0) acc.drawn += (row.powerW * dtMs) / 3_600_000;
        else acc.returned += (-row.powerW * dtMs) / 3_600_000;
      }
      acc.last = row.takenAt.getTime();
      byChannel.set(row.channel, acc);
    }

    const corrected = correctChannelEnergy(
      [...byChannel.entries()].map(([channel, acc]) => ({
        channel,
        drawnWh: acc.drawn,
        returnedWh: acc.returned,
        multiplier: labels[String(channel)]?.voltageMultiplier ?? 1,
      })),
      deviceDrawnWh,
    );

    return corrected
      .map((c) => ({
        channel: c.channel,
        label: labels[String(c.channel)]?.label ?? `Circuit ${c.channel}`,
        energyKwh: Number((c.drawnWh / 1000).toFixed(2)),
        returnedKwh: c.returnedWh > 0 ? Number((c.returnedWh / 1000).toFixed(2)) : undefined,
        sharePct: c.sharePct,
        ...(c.multiplier !== 1 ? { voltageMultiplier: c.multiplier } : {}),
      }))
      .sort((a, b) => b.energyKwh - a.energyKwh);
  }

  /** Per-circuit config for a device, keyed by channel number. */
  private channelLabels(device: Device): Record<string, ChannelConfig> {
    try {
      const config = device.config ? (JSON.parse(device.config) as { channels?: unknown }) : {};
      return (config.channels ?? {}) as Record<string, ChannelConfig>;
    } catch {
      return {};
    }
  }

  /**
   * Control path: criticality is enforced here, not in the UI.
   * Returns the device's state read back after the change.
   */
  async command(
    id: number,
    action: string,
    value?: number,
  ): Promise<(DeviceState & { updatedAt: string }) | null> {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('unknown device');
    if (device.critical) {
      throw new ForbiddenException(`${device.name} is marked critical — read-only`);
    }
    const adapter = this.adapters.get(device.vendor);
    if (!adapter) throw new BadRequestException('no adapter for vendor');
    if (action === 'on' || action === 'off') {
      if (!adapter.setOn) throw new BadRequestException('device cannot switch');
      await adapter.setOn(device, action === 'on');
    } else if (action === 'setTarget') {
      if (!adapter.setTargetTemperature) throw new BadRequestException('device has no setpoint');
      if (value === undefined || !Number.isFinite(value) || value < 5 || value > 30) {
        throw new BadRequestException('setTarget needs a temperature between 5 and 30');
      }
      await adapter.setTargetTemperature(device, value);
    } else {
      throw new BadRequestException(`unknown action ${action}`);
    }
    this.logger.log(`command: ${device.name} ← ${action}${value !== undefined ? ` ${value}` : ''}`);
    // Awaited, and only this device: returning the fresh state stops a caller's refetch
    // from racing the poll and re-rendering the pre-command value.
    return this.pollOne(device);
  }

  /**
   * Poll one device and refresh its live state. Deliberately does NOT persist a reading:
   * command echoes would inflate on-time for whichever device is fiddled with most.
   */
  private async pollOne(device: Device): Promise<(DeviceState & { updatedAt: string }) | null> {
    const adapter = this.adapters.get(device.vendor);
    if (!adapter) return null;
    try {
      const state = await adapter.poll(device);
      const entry = { ...state, updatedAt: new Date().toISOString() };
      this.live.set(device.id, entry);
      return entry;
    } catch (error) {
      // The command already succeeded; failing to read back is not a failed command.
      this.logger.debug(`post-command poll ${device.name}: ${(error as Error).message}`);
      return this.live.get(device.id) ?? null;
    }
  }

  /**
   * From stored state readings, reconstruct how long each device spent on and (where
   * metered) its energy, over a window. Flags long daily on-time and always-on standby
   * draw; controls nothing.
   */
  async getUsage(days: number): Promise<DeviceUsageDto[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const devices = await this.prisma.device.findMany({ where: { enabled: true } });
    const out: DeviceUsageDto[] = [];

    for (const device of devices) {
      const readings = await this.prisma.deviceReading.findMany({
        // Channel 0 only: the per-leg rows a multi-channel meter writes would double-count.
        where: { deviceId: device.id, channel: 0, takenAt: { gte: since } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, on: true, powerW: true, heating: true, energyTodayWh: true },
      });
      if (readings.length < 2) continue;

      // A line-voltage thermostat reports no power, so energy is duty cycle x the element's
      // rated watts, supplied by the owner (config: {"ratedW": 1500}). Without it, on-time.
      const loadConfig = readLoadConfig(device.config);

      // Carry each reading's state to the next sample, capping gaps so downtime does not
      // inflate the total.
      let onMs = 0;
      let heatingMs = 0;
      let energyWh = 0;
      let drawnWh = 0;
      let returnedWh = 0;
      let standbySamples = 0;
      let poweredSamples = 0;
      for (let i = 0; i < readings.length - 1; i++) {
        const dtMs = Math.min(
          readings[i + 1].takenAt.getTime() - readings[i].takenAt.getTime(),
          MAX_USAGE_GAP_MS,
        );
        if (readings[i].on) onMs += dtMs;
        if (readings[i].heating) heatingMs += dtMs;
        const w = readings[i].powerW;
        if (w !== null && w !== undefined) {
          // Split by sign: a whole-home meter reports negative watts while exporting, and
          // summing straight through nets solar export against household consumption.
          if (w >= 0) drawnWh += (w * dtMs) / 3_600_000;
          else returnedWh += (-w * dtMs) / 3_600_000;
          if (readings[i].on === false && w > STANDBY_W) standbySamples++;
          poweredSamples++;
        }
      }
      energyWh = drawnWh;
      const onHoursPerDay = onMs / 3_600_000 / days;
      const metered = poweredSamples > 0;
      // Estimated, not measured — flagged as such in the DTO so the UI can say so.
      const heatingHours = heatingMs / 3_600_000;
      /*
        A thermostat's consumption tracks the hours it CALLED FOR HEAT, not the hours it was
        powered. Everything else tracks on-time: `heating` is never set on a switch, so
        heatingHours unconditionally reports 0.0 kWh for a plug with a rated wattage.
      */
      const activeHours = device.kind === 'thermostat' ? heatingHours : onMs / 3_600_000;
      /* Some hardware reports a resetting daily energy figure and no instantaneous power
         (Daikin). That is MEASURED and outranks any estimate; each day's maximum sums to
         the window's total. */
      const reportedDaily = sumDailyMaxima(
        readings.map((r) => ({
          localDate: localDateOf(r.takenAt),
          energyTodayWh: r.energyTodayWh,
        })),
      );
      const estimate =
        metered || reportedDaily !== null ? null : estimateFromOnTime(activeHours, loadConfig);
      if (reportedDaily !== null && !metered) energyWh = reportedDaily;
      else if (estimate) energyWh = estimate.energyWh;
      const observations: string[] = [];
      if (device.kind === 'switch' || device.kind === 'light' || device.kind === 'plug') {
        if (onHoursPerDay > LONG_ON_HOURS) {
          observations.push(
            `On ~${onHoursPerDay.toFixed(1)} h/day — a sunset/sunrise schedule (device-side) could trim this.`,
          );
        }
      }
      if (metered && standbySamples / Math.max(1, poweredSamples) > STANDBY_SHARE) {
        observations.push('Draws standby power while off — a candidate for a true-off schedule.');
      }
      if (heatingMs > 0) {
        const duty = (heatingMs / (readings.length > 1 ? days * 24 * 3_600_000 : 1)) * 100;
        observations.push(
          loadConfig.ratedW
            ? `Called for heat ${heatingHours.toFixed(1)} h (${duty.toFixed(0)}% of the time) — energy estimated from ${loadConfig.ratedW} W.`
            : `Called for heat ${heatingHours.toFixed(1)} h (${duty.toFixed(0)}% of the time). Set the heater's rated watts to estimate its energy.`,
        );
      }
      // Every estimate says how far to trust it; an unmetered device with nothing declared
      // asks for a wattage rather than reporting no energy.
      if (estimate) {
        const what = estimate.label ? `${estimate.label}: ` : '';
        observations.push(`${what}estimated from ${activeHours.toFixed(1)} h on × ${loadConfig.ratedW} W. ${estimate.note}`);
      } else if (!metered && device.kind !== 'thermostat') {
        observations.push(
          'This device reports no power. Say what it runs and roughly how many watts it draws, and its energy can be estimated from on-time.',
        );
      }
      out.push({
        deviceId: device.id,
        name: device.name,
        kind: device.kind,
        onHoursPerDay: Number(onHoursPerDay.toFixed(1)),
        energyKwh:
          metered || estimate || reportedDaily !== null
            ? Number((energyWh / 1000).toFixed(2))
            : null,
        // A device-reported daily figure IS measured, even without a power reading.
        metered: metered || reportedDaily !== null,
        estimated: estimate !== null,
        confidence: estimate?.confidence,
        loadLabel: loadConfig.loadLabel,
        heatingHours: heatingMs > 0 ? Number(heatingHours.toFixed(1)) : undefined,
        returnedKwh: returnedWh > 0 ? Number((returnedWh / 1000).toFixed(2)) : undefined,
        channels: await this.channelUsage(device, since, drawnWh),
        observations,
      });
    }
    return out.sort((a, b) => (b.energyKwh ?? b.onHoursPerDay) - (a.energyKwh ?? a.onHoursPerDay));
  }

  listSchedules(deviceId: number): Promise<object[]> {
    return this.prisma.deviceSchedule.findMany({
      where: { deviceId },
      orderBy: { id: 'asc' },
    });
  }

  async addSchedule(
    deviceId: number,
    input: { action: string; trigger: string; timeOfDay?: string; offsetMin?: number; value?: number },
  ): Promise<object> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('unknown device');
    if (input.trigger === 'time' && !/^\d{1,2}:\d{2}$/.test(input.timeOfDay ?? '')) {
      throw new BadRequestException('time trigger needs timeOfDay as HH:MM');
    }
    return this.prisma.deviceSchedule.create({
      data: {
        deviceId,
        action: input.action,
        trigger: input.trigger,
        timeOfDay: input.trigger === 'time' ? input.timeOfDay : null,
        offsetMin: input.offsetMin ?? 0,
        value: input.value ?? null,
      },
    });
  }

  async removeSchedule(id: number): Promise<object> {
    await this.prisma.deviceSchedule.delete({ where: { id } });
    return { ok: true };
  }

  async pairHomeKit(id: number, pin: string): Promise<void> {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('unknown device');
    if (device.vendor !== 'mysa') throw new BadRequestException('pairing is for Mysa devices');
    const config = await pairMysa(device.host, device.port ?? 0, device.hardwareId ?? '', pin);
    await this.prisma.device.update({ where: { id }, data: { config } });
    this.logger.log(`paired HomeKit device ${device.name}`);
    void this.pollAll();
  }
}
