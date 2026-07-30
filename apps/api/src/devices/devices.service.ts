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
const CONNECT_TIMEOUT_MS = 1_200;
/** Hot legs a single CT can be missing: 1 (none), 2 (split-phase 240 V), 3 (three-phase). */
const VALID_MULTIPLIERS = new Set([1, 2, 3]);

/** Per-circuit settings stored in a meter's config JSON, keyed by channel number. */
interface ChannelConfig {
  label?: string;
  ratedW?: number;
  /**
   * A CT on ONE leg of a 240 V two-pole circuit, referenced to a 120 V line input,
   * reports exactly half the true power — the meter multiplies its single voltage
   * reading by the one current it can see.
   *
   * Doubling is exact rather than approximate: on split-phase the line-to-line
   * voltage is in phase with line-to-neutral and twice its magnitude, so the
   * correction holds for a reactive load as well as a resistive one. It is
   * therefore safe on an inverter mini split, not just a baseboard element.
   *
   * Shelly exposes no doubling setting (its channel config takes only `name`,
   * `reverse`, `ct_type`, `alarms`), so the correction has to live here. Applied on
   * read, never on write: the stored reading stays what the meter actually said, so
   * correcting a mis-set multiplier retroactively fixes history instead of leaving
   * a permanent step in the data.
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
  /**
   * How far to trust an estimate. A resistive heater is 'good'; a variable-speed pump
   * is 'rough' and closer to a ceiling. Absent when the figure was measured.
   */
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
          // Multi-channel hardware also records each leg, sharing the timestamp so
          // the rows line up. Channel 0 above stays the whole-device total.
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
   * Find devices on the LAN.
   *
   * Delegates to NetworkScanner, which plans the network work from the registered
   * probes. This method used to BE the discovery logic — a sequence of hardcoded
   * sweeps that grew a branch per vendor. Adding one now means writing a probe and
   * registering it; see discovery/probes.ts.
   */
  async scan(subnetPrefixes: string[]): Promise<ScanResult> {
    if (subnetPrefixes.length === 0) throw new BadRequestException('at least one subnet is required');
    // Bounded because each subnet is 254 hosts per port; a careless caller asking for
    // twenty would tie up the scanner for a very long time.
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
    // Sequential, not parallel: running several sweeps at once multiplies the load on
    // a network we are deliberately being gentle with.
    const results: ScanResult[] = [];
    for (const prefix of subnetPrefixes) results.push(await scanner.scan(prefix, ctx));
    return {
      devices: results.flatMap((r) => r.devices),
      lookedFor: results[0]?.lookedFor ?? [],
      scanned: subnetPrefixes,
    };
  }

  /**
   * Where it is worth scanning, and why.
   *
   * Adopted device addresses are the strongest evidence available — far better than
   * our own interface, which inside Docker is a bridge network that tells us nothing
   * about the user's LAN.
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
   * Declare what a device runs and roughly what it draws.
   *
   * This is the whole answer for a switch-only plug: the hardware cannot measure, but
   * the owner knows it is the pool pump. Storing the load TYPE alongside the wattage
   * is what keeps the resulting figure honest — a resistive heater and a
   * variable-speed pump produce estimates of very different quality from identical
   * arithmetic, and presenting them the same way would be the lie.
   */
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
   * Store a vendor credential in the device config, merging rather than replacing.
   *
   * The same blob carries HomeKit pairing data, meter channel labels and load settings,
   * so writing the whole thing would silently discard whichever of those had been set.
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
   * Name a multi-channel meter's legs and, optionally, give each the wattage of what
   * it feeds. "Channel 7" tells an owner nothing; "Dryer" is the whole point of
   * clamping sixteen circuits. Stored in the device's config JSON alongside its other
   * vendor settings rather than a new table — the shape is small and per-device.
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
        // Deliberately an allow-list, not a range. The multiplier encodes how many
        // hot legs the CT missed, which is 1 or 2 on residential split-phase and 3
        // on three-phase. A free-form 1.7 would be a fudge factor, not a wiring fact.
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
   * Per-circuit energy for a multi-channel meter, ranked by consumption — "which
   * appliance is costing me" rather than "channel 7". Returns undefined for
   * single-channel hardware so the DTO stays clean for ordinary plugs.
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
    // Awaited, and only this device.
    //
    // Previously `void this.pollAll()` — fire-and-forget, every device, each with its
    // own multi-second timeout. The response returned immediately, so the UI's
    // refetch raced the poll and reliably lost: the button was re-rendered from the
    // cache written up to a minute earlier and still read "Turn on" after turning on.
    // Returning the fresh state means the caller cannot observe the stale one.
    return this.pollOne(device);
  }

  /**
   * Poll one device and refresh its live state.
   *
   * Deliberately does NOT persist a reading. The history is a record of what the
   * device did on its own schedule; writing an extra row every time someone taps a
   * button would put command echoes into the same series the usage maths integrates
   * over, inflating on-time for whichever device is most fiddled with. The next
   * scheduled poll records the new state normally.
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
      // The command itself already succeeded; failing to read back is not a failed
      // command, so report the stale value rather than turning this into an error.
      this.logger.debug(`post-command poll ${device.name}: ${(error as Error).message}`);
      return this.live.get(device.id) ?? null;
    }
  }

  /**
   * Monitor-first savings view: from stored state readings, reconstruct how long
   * each device spent on and (where metered) its energy, over a window. Flags
   * patterns worth acting on — long daily on-time, always-on standby draw —
   * without controlling anything.
   */
  async getUsage(days: number): Promise<DeviceUsageDto[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const devices = await this.prisma.device.findMany({ where: { enabled: true } });
    const out: DeviceUsageDto[] = [];

    for (const device of devices) {
      const readings = await this.prisma.deviceReading.findMany({
        // Channel 0 only — the whole-device figure. Including the per-leg rows a
        // multi-channel meter writes would count its energy twice over.
        where: { deviceId: device.id, channel: 0, takenAt: { gte: since } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true, on: true, powerW: true, heating: true, energyTodayWh: true },
      });
      if (readings.length < 2) continue;

      // A line-voltage thermostat reports no power at all, so the only local energy
      // estimate is duty cycle x the element's rated watts — which the owner has to
      // tell us (config: {"ratedW": 1500}). Without it we report on-time only rather
      // than inventing a figure.
      const loadConfig = readLoadConfig(device.config);

      // Integrate on-time by carrying each reading's state to the next sample,
      // capping gaps so downtime doesn't inflate the total.
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
          // Split by sign. A whole-home meter reports negative watts while exporting,
          // and summing straight through would silently net solar export against
          // household consumption — making a good solar day look like low usage.
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
        A thermostat's consumption tracks the hours it CALLED FOR HEAT, not the hours
        it was powered — it is on all winter and heating a fraction of it. Everything
        else tracks on-time.

        This used to use heatingHours unconditionally. On a switch, `heating` is never
        set, so heatingMs stayed 0 and any plug with a rated wattage reported a
        confident 0.0 kWh — the same unknown-as-zero fault this codebase keeps
        turning up, this time in a number we computed ourselves.
      */
      const activeHours = device.kind === 'thermostat' ? heatingHours : onMs / 3_600_000;
      /*
        Some hardware reports a resetting daily energy figure and no instantaneous
        power at all — Daikin air conditioners do. That is a MEASURED number, so it
        outranks any estimate: summing each day's maximum gives the window's total
        without needing a wattage the owner had to guess at.
      */
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
      // Every estimated figure says how far to trust it, and an unmetered device with
      // nothing declared invites the owner to say what it feeds rather than silently
      // reporting no energy.
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
        // A device-reported daily figure IS measured, even without a power reading —
        // so it must not be labelled an estimate in the UI.
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
