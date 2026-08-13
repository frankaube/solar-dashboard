import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DailyCounterTracker } from '../common/daily-counter';
import { localDateOf } from '../common/localdate';
import { INVERTER_COUNT_SETTING_KEY, PV_COUNT_SETTING_KEY } from '../common/settings-keys';
import { AlertsService } from '../alerts/alerts.service';
import { NotifierService } from '../alerts/notifier.service';
import { MqttService } from '../integrations/mqtt.service';
import { discoverDtuHost, subnetPrefixOf } from '../hoymiles/discovery';
import { InverterDataSource, SystemSnapshot } from '../hoymiles/types';
import { DEFAULT_VENDOR, INVERTER_VENDORS } from '../datasource/vendors';
import { pingWatchdog } from '../common/watchdog';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const REDISCOVERY_FAILURE_THRESHOLD = 5;
const REDISCOVERY_COOLDOWN_MS = 5 * 60_000;
const INFO_REFRESH_MS = 24 * 60 * 60_000;
const DTU_MODEL = 'DTU-Pro-S';
export const DTU_HOST_SETTING = 'dtuHost';
export const SOLAR_VENDOR_SETTING = 'solarVendor';

interface InverterCacheEntry {
  id: number;
  portIds: Map<number, number>;
}

@Injectable()
export class CollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CollectorService.name);
  private client: InverterDataSource | null = null;
  private vendor = DEFAULT_VENDOR;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private consecutiveFailures = 0;
  private lastRediscoveryAt = 0;
  private lastSnapshot: SystemSnapshot | null = null;
  private lastSuccessAt: Date | null = null;
  private lastPersistedTimestamp = 0;
  /** Suppresses the DTU's post-midnight carryover; see DailyCounterTracker. */
  private readonly dailyCounter = new DailyCounterTracker();
  private dtuId: number | null = null;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private expectedInverterCount: number | null = null;
  private lastInfoRefreshAt = 0;
  private readonly inverterCache = new Map<string, InverterCacheEntry>();

  private outageNotified = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly notifier: NotifierService,
    private readonly mqtt: MqttService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedCounterState();
    const [hostSetting, vendorSetting] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: DTU_HOST_SETTING } }),
      this.prisma.setting.findUnique({ where: { key: SOLAR_VENDOR_SETTING } }),
    ]);
    const host = hostSetting?.value || process.env.DTU_HOST;
    this.vendor = vendorSetting?.value || process.env.SOLAR_VENDOR || DEFAULT_VENDOR;
    if (!host) {
      this.logger.warn('No solar gateway configured — open Settings → Hardware to scan for one.');
      return;
    }
    this.startPolling(host);
  }

  /**
   * Restore counter-reset state from the last stored reading, so a restart inside the
   * post-midnight window doesn't reintroduce a carryover row on the first poll.
   */
  private async seedCounterState(): Promise<void> {
    const last = await this.prisma.dtuReading.findFirst({
      orderBy: { takenAt: 'desc' },
      select: { localDate: true, dailyEnergy: true },
    });
    if (!last) return;
    this.dailyCounter.seed(last.localDate, last.dailyEnergy);
  }

  /** Point the collector at a (new) gateway; optionally switch vendor. Starts polling if idle. */
  applyHost(host: string, vendor?: string): void {
    if (vendor && vendor !== this.vendor) {
      this.vendor = vendor;
      this.client = null; // rebuild with the new vendor's client
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
    if (this.client) {
      const previous = this.client.getHost();
      this.client.setHost(host);
      if (previous !== host) this.logger.log(`Gateway host changed: ${previous} → ${host}`);
      return;
    }
    this.startPolling(host);
  }

  private startPolling(host: string): void {
    const vendor = INVERTER_VENDORS[this.vendor] ?? INVERTER_VENDORS[DEFAULT_VENDOR];
    this.client = vendor.createSource(host);
    this.pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    void this.poll();
    this.logger.log(`Collector polling ${vendor.name} at ${host} every ${this.pollIntervalMs} ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getLastSnapshot(): SystemSnapshot | null {
    return this.lastSnapshot;
  }

  getStatus(): object {
    return {
      dtuHost: this.client?.getHost() ?? null,
      pollIntervalMs: this.pollIntervalMs,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastSnapshotAt: this.lastSnapshot?.takenAt.toISOString() ?? null,
      consecutiveFailures: this.consecutiveFailures,
      expectedInverterCount: this.expectedInverterCount,
      reportingInverterCount: this.lastSnapshot?.inverters.length ?? null,
    };
  }

  /** The DTU knows how many inverters are registered — needed to detect silent units. */
  private async refreshInfo(): Promise<void> {
    if (!this.client || Date.now() - this.lastInfoRefreshAt < INFO_REFRESH_MS) return;
    try {
      const info = await this.client.fetchInfo();
      this.expectedInverterCount = info.inverterCount;
      /*
        Record the array's true size, because it is not the number of panels we have
        data for.

        The DTU reports 42 panels here while its RealData pages carry 38 — one
        four-panel inverter is registered, online in the vendor cloud, contributing to
        the DTU's own power total, and simply absent from the per-inverter response.
        Counting stored rows therefore under-reports the roof by four panels, and that
        count also drives the capacity estimate when no rated size is configured.
      */
      if (info.pvCount > 0) {
        // Written straight to the settings table rather than through ReadingsService:
        // that service reads this value, and injecting it here would be circular.
        const value = String(info.pvCount);
        await this.prisma.setting.upsert({
          where: { key: PV_COUNT_SETTING_KEY },
          create: { key: PV_COUNT_SETTING_KEY, value },
          update: { value },
        });
      }
      if (info.inverterCount > 0) {
        const count = String(info.inverterCount);
        await this.prisma.setting.upsert({
          where: { key: INVERTER_COUNT_SETTING_KEY },
          create: { key: INVERTER_COUNT_SETTING_KEY, value: count },
          update: { value: count },
        });
      }
      this.lastInfoRefreshAt = Date.now();
    } catch (error) {
      this.logger.warn(`DTU info refresh failed: ${(error as Error).message}`);
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.client) return;
    this.polling = true;
    try {
      await this.refreshInfo();
      const snapshot = await this.client.fetchSnapshot();
      this.lastSnapshot = snapshot;
      this.lastSuccessAt = new Date();
      this.consecutiveFailures = 0;
      if (this.outageNotified) {
        this.outageNotified = false;
        await this.notifier.send('✅ Collector reconnected to the DTU.');
      }
      await this.persist(snapshot);
      await this.alerts.processSnapshot(snapshot, this.expectedInverterCount);
      this.mqtt.publishSnapshot(snapshot);
    } catch (error) {
      this.consecutiveFailures++;
      this.logger.warn(
        `Poll failed (${this.consecutiveFailures} in a row): ${(error as Error).message}`,
      );
      if (this.consecutiveFailures >= REDISCOVERY_FAILURE_THRESHOLD) {
        if (!this.outageNotified) {
          this.outageNotified = true;
          await this.notifier.send(
            `⚠️ Collector cannot reach the DTU (${this.consecutiveFailures} failed polls) — attempting rediscovery.`,
          );
        }
        await this.rediscover();
      }
    } finally {
      this.polling = false;
      /*
        In `finally`, so a poll that failed still counts as the loop turning. A DTU that is
        switched off is not a reason to restart the service — the app is working and saying
        it cannot reach the gateway. What must never happen is a cycle that does not come
        back at all, and the early return above on `this.polling` means exactly that case
        stops feeding the watchdog.
      */
      pingWatchdog();
    }
  }

  /** The DTU may serve the same reading twice in a row; only new timestamps are stored. */
  private async persist(snapshot: SystemSnapshot): Promise<void> {
    const timestamp = Math.floor(snapshot.takenAt.getTime() / 1000);
    if (timestamp === this.lastPersistedTimestamp) {
      this.logger.debug(`DTU data unchanged (ts ${timestamp}); skipping insert`);
      return;
    }

    const dtuId = await this.ensureDtu(snapshot.dtuSerialNumber);
    await this.ensureInventory(dtuId, snapshot);

    const localDate = localDateOf(snapshot.takenAt);
    const wasCarrying = this.dailyCounter.carryingOver;
    const dailyEnergy = this.dailyCounter.resolve(localDate, snapshot.dailyEnergyWh);
    if (this.dailyCounter.carryingOver && !wasCarrying) {
      this.logger.log(
        `Daily counter has not reset for ${localDate} (still reporting ` +
          `${snapshot.dailyEnergyWh} Wh); recording 0 until it does.`,
      );
    }

    await this.prisma.dtuReading.create({
      data: {
        dtuId,
        takenAt: snapshot.takenAt,
        localDate,
        totalPower: snapshot.totalPower,
        dailyEnergy,
        // Kept so a source that reports only a lifetime accumulator (SunSpec) can
        // still have its day derived. Sources with a real daily counter leave it null.
        lifetimeEnergy: snapshot.totalEnergyWh ?? null,
      },
    });
    await this.prisma.inverterReading.createMany({
      data: snapshot.inverters.map((inv) => ({
        microinverterId: this.inverterCache.get(inv.serialNumber)!.id,
        takenAt: snapshot.takenAt,
        gridVoltage: inv.gridVoltage,
        gridFrequency: inv.gridFrequency,
        activePower: inv.activePower,
        reactivePower: inv.reactivePower,
        current: inv.current,
        powerFactor: inv.powerFactor,
        // The columns are non-null; vendors that don't report these get a neutral
        // default here rather than the adapter inventing a reading. linkStatus
        // defaults to 1 (up) because a vendor that reports nothing has, by
        // definition, answered us.
        temperature: inv.temperature ?? 0,
        powerLimitPct: inv.powerLimitPct ?? 100,
        warningNumber: inv.warningNumber ?? 0,
        linkStatus: inv.linkStatus ?? 1,
        rfSignal: inv.rfSignal ?? 0,
      })),
    });
    await this.prisma.portReading.createMany({
      data: snapshot.ports.map((port) => ({
        pvPortId: this.inverterCache
          .get(port.inverterSerialNumber)!
          .portIds.get(port.portNumber)!,
        takenAt: snapshot.takenAt,
        voltage: port.voltage,
        current: port.current,
        power: port.power,
        energyDaily: port.energyDailyWh,
        energyTotal: port.energyTotalWh,
        errorCode: port.errorCode,
      })),
    });

    this.lastPersistedTimestamp = timestamp;
    this.logger.debug(
      `Stored snapshot ${snapshot.takenAt.toISOString()}: ${snapshot.totalPower} W, ` +
        `${snapshot.inverters.length} inverters, ${snapshot.ports.length} ports`,
    );
  }

  private async ensureDtu(serialNumber: string): Promise<number> {
    if (this.dtuId !== null) return this.dtuId;
    const host = this.client!.getHost();
    const dtu = await this.prisma.dtu.upsert({
      where: { serialNumber },
      create: { serialNumber, host, model: DTU_MODEL },
      update: { host },
    });
    this.dtuId = dtu.id;
    return dtu.id;
  }

  private async ensureInventory(dtuId: number, snapshot: SystemSnapshot): Promise<void> {
    const portCounts = new Map<string, number>();
    for (const port of snapshot.ports) {
      portCounts.set(
        port.inverterSerialNumber,
        Math.max(portCounts.get(port.inverterSerialNumber) ?? 0, port.portNumber),
      );
    }

    for (const inv of snapshot.inverters) {
      if (this.inverterCache.has(inv.serialNumber)) continue;
      const row = await this.prisma.microinverter.upsert({
        where: { serialNumber: BigInt(inv.serialNumber) },
        create: {
          dtuId,
          serialNumber: BigInt(inv.serialNumber),
          portCount: portCounts.get(inv.serialNumber) ?? 0,
        },
        update: {},
      });
      this.inverterCache.set(inv.serialNumber, { id: row.id, portIds: new Map() });
    }

    for (const port of snapshot.ports) {
      const entry = this.inverterCache.get(port.inverterSerialNumber);
      if (!entry || entry.portIds.has(port.portNumber)) continue;
      const row = await this.prisma.pvPort.upsert({
        where: {
          microinverterId_portNumber: {
            microinverterId: entry.id,
            portNumber: port.portNumber,
          },
        },
        create: { microinverterId: entry.id, portNumber: port.portNumber },
        update: {},
      });
      entry.portIds.set(port.portNumber, row.id);
    }
  }

  /** After sustained failures, re-scan the subnet for the DTU's serial (it is DHCP-assigned). */
  private async rediscover(): Promise<void> {
    // Serial-based rediscovery is Hoymiles-specific; other vendors just retry the host.
    if (this.vendor !== 'hoymiles') return;
    const expectedSerial = process.env.DTU_SERIAL ?? this.lastSnapshot?.dtuSerialNumber;
    if (!this.client || !expectedSerial) return;
    if (Date.now() - this.lastRediscoveryAt < REDISCOVERY_COOLDOWN_MS) return;
    this.lastRediscoveryAt = Date.now();

    const currentHost = this.client.getHost();
    this.logger.warn(`Rediscovering DTU ${expectedSerial} on subnet of ${currentHost}…`);
    const found = await discoverDtuHost(subnetPrefixOf(currentHost), expectedSerial);
    if (!found) {
      this.logger.error('Rediscovery found no DTU — is it powered and on Wi-Fi?');
      return;
    }
    if (found !== currentHost) {
      this.logger.warn(`DTU moved: ${currentHost} → ${found}`);
      this.client.setHost(found);
      if (this.dtuId !== null) {
        await this.prisma.dtu.update({ where: { id: this.dtuId }, data: { host: found } });
      }
    }
    this.consecutiveFailures = 0;
  }
}
