import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ArrayCensusService } from './array-census.service';
import { INVERTER_COUNT_SETTING_KEY } from '../common/settings-keys';
import {
  Attempt,
  SourceGroup,
  SourceRow,
  SourcesDto,
  attemptsFrom,
  cadenceText,
  headlineFor,
  noAttempts,
  stateOf,
  tallyOf,
} from './sources';

/**
 * Assembled from stored readings, not the collector: a path back would be circular and
 * takes the API down at boot, and a stored reading proves data arrived.
 */

const DEFAULT_POLL_MS = 300_000;
/**
 * How often a healthy charger WRITES, not its poll interval: the Wall Connector is asked
 * every 30 s charging and 5 min idle, but stores only on a state change or every 15 min.
 */
const CHARGER_HEARTBEAT_MS = 15 * 60_000;
/**
 * How often a healthy device WRITES, not how often it is polled: `DevicesService` polls
 * every minute but stores only on a state change or every 15 min, so measuring against
 * the poll shows a healthy thermostat missing eleven of twelve attempts.
 */
const DEVICE_HEARTBEAT_MS = 15 * 60_000;
const WEATHER_POLL_MS = 30 * 60_000;
const BUCKETS = 12;

/** How far back the strip needs readings for, plus slack. */
const historyWindow = (cadenceMs: number): Date =>
  new Date(Date.now() - cadenceMs * (BUCKETS + 2));

@Injectable()
export class SourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly census: ArrayCensusService,
  ) {}

  private async setting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  async get(now: Date = new Date()): Promise<SourcesDto> {
    const groups: SourceGroup[] = [
      await this.roof(now),
      await this.car(now),
      await this.house(now),
      await this.feeds(now),
    ].filter((group) => group.sources.length > 0);

    return {
      generatedAt: now.toISOString(),
      groups,
      tally: tallyOf(groups),
      headline: headlineFor(groups),
    };
  }

  /** The gateway, and what it is carrying. Only this group feeds the money figures. */
  private async roof(now: Date): Promise<SourceGroup> {
    const pollMs = Number(process.env.POLL_INTERVAL_MS ?? DEFAULT_POLL_MS) || DEFAULT_POLL_MS;
    const [host, latest, recent, census, expectedRaw, inverters] = await Promise.all([
      this.setting('dtuHost'),
      this.prisma.dtuReading.findFirst({ orderBy: { takenAt: 'desc' }, select: { takenAt: true } }),
      this.prisma.dtuReading.findMany({
        where: { takenAt: { gte: historyWindow(pollMs) } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true },
      }),
      this.census.get().catch(() => null),
      // Inputs to the census, not on its DTO; read the same way rather than widening it.
      this.setting(INVERTER_COUNT_SETTING_KEY),
      this.prisma.microinverter.findMany({ select: { _count: { select: { ports: true } } } }),
    ]);
    const expectedInverters = Number(expectedRaw);
    const reportingInverters = inverters.filter((inv) => inv._count.ports > 0).length;

    const lastSeenAt = latest?.takenAt ?? null;
    const attempts = attemptsFrom(recent.map((row) => row.takenAt), pollMs, BUCKETS, now);
    const claim = (source: string): number | null =>
      census?.claims.find((entry) => entry.source === source)?.panels ?? null;
    const registered = claim('Gateway registered');
    const reporting = claim('Sending detail');
    const onPaper = claim('Your paperwork');

    const gateway: SourceRow = {
      id: 'gateway',
      name: 'Solar gateway',
      detail: host ? `${host}` : 'not configured',
      state: stateOf({ configured: host !== null, lastSeenAt, cadenceMs: pollMs }, now),
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
      cadenceMs: pollMs,
      cadenceText: cadenceText(pollMs),
      attempts,
    };

    const sources: SourceRow[] = [gateway];

    // Not separately polled; listed because "answered" and "told us about every panel"
    // are different facts.
    if (census) {
      const knownExpected = Number.isFinite(expectedInverters) && expectedInverters > 0;
      const invertersShort = knownExpected && reportingInverters < expectedInverters;
      sources.push({
        id: 'inverters',
        name: 'Microinverters',
        detail: knownExpected
          ? `${reportingInverters} of ${expectedInverters} sending detail`
          : `${reportingInverters} sending detail`,
        state: stateOf(
          { configured: true, lastSeenAt, cadenceMs: pollMs, incomplete: invertersShort },
          now,
        ),
        lastSeenAt: lastSeenAt?.toISOString() ?? null,
        cadenceMs: pollMs,
        cadenceText: 'with the gateway',
        attempts,
      });

      const panelsShort = reporting !== null && onPaper !== null && reporting < onPaper;
      sources.push({
        id: 'panels',
        name: 'Panels',
        detail: [
          reporting === null ? null : `${reporting} reporting`,
          registered === null ? null : `${registered} registered`,
          onPaper === null ? null : `${onPaper} on paper`,
        ].filter(Boolean).join(' · '),
        state: stateOf(
          { configured: true, lastSeenAt, cadenceMs: pollMs, incomplete: panelsShort },
          now,
        ),
        lastSeenAt: lastSeenAt?.toISOString() ?? null,
        cadenceMs: pollMs,
        cadenceText: 'with the gateway',
        attempts,
      });
    }

    return {
      id: 'roof',
      title: 'The roof',
      note:
        'Partial is not late. The gateway answers on time; it is what it says that is short, ' +
        'and a panel it has never registered is absent from every figure rather than hidden.',
      sources,
    };
  }

  private async car(now: Date): Promise<SourceGroup> {
    const [chargerHost, latestCharge, recentCharge] = await Promise.all([
      this.setting('chargerHost'),
      this.prisma.chargerReading.findFirst({
        orderBy: { takenAt: 'desc' },
        select: { takenAt: true },
      }),
      this.prisma.chargerReading.findMany({
        where: { takenAt: { gte: historyWindow(CHARGER_HEARTBEAT_MS) } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true },
      }),
    ]);

    const sources: SourceRow[] = [];
    if (chargerHost) {
      const lastSeenAt = latestCharge?.takenAt ?? null;
      sources.push({
        id: 'charger',
        name: 'EV charger',
        detail: `local API · ${chargerHost}`,
        state: stateOf({ configured: true, lastSeenAt, cadenceMs: CHARGER_HEARTBEAT_MS }, now),
        lastSeenAt: lastSeenAt?.toISOString() ?? null,
        cadenceMs: CHARGER_HEARTBEAT_MS,
        cadenceText: cadenceText(CHARGER_HEARTBEAT_MS),
        attempts: attemptsFrom(recentCharge.map((r) => r.takenAt), CHARGER_HEARTBEAT_MS, BUCKETS, now),
      });
    }
    return { id: 'car', title: 'The car', sources };
  }

  /** Everything the scan found and somebody adopted. */
  private async house(now: Date): Promise<SourceGroup> {
    const devices = await this.prisma.device.findMany({
      select: { id: true, name: true, vendor: true, kind: true, host: true, enabled: true },
      orderBy: { name: 'asc' },
    });
    if (devices.length === 0) return { id: 'house', title: 'Around the house', sources: [] };

    const since = historyWindow(DEVICE_HEARTBEAT_MS);
    const readings = await this.prisma.deviceReading.findMany({
      where: { takenAt: { gte: since } },
      orderBy: { takenAt: 'asc' },
      select: { deviceId: true, takenAt: true },
    });
    const latest = await this.prisma.deviceReading.groupBy({
      by: ['deviceId'],
      _max: { takenAt: true },
    });
    const lastById = new Map(latest.map((row) => [row.deviceId, row._max.takenAt ?? null]));

    const sources = devices.map((device) => {
      const lastSeenAt = lastById.get(device.id) ?? null;
      const mine = readings.filter((row) => row.deviceId === device.id).map((row) => row.takenAt);
      return {
        id: `device-${device.id}`,
        name: device.name,
        detail: `${device.vendor} ${device.kind} · ${device.host}`,
        state: stateOf(
          { configured: device.enabled, lastSeenAt, cadenceMs: DEVICE_HEARTBEAT_MS },
          now,
        ),
        lastSeenAt: lastSeenAt?.toISOString() ?? null,
        cadenceMs: DEVICE_HEARTBEAT_MS,
        cadenceText: cadenceText(DEVICE_HEARTBEAT_MS),
        attempts: device.enabled
          ? attemptsFrom(mine, DEVICE_HEARTBEAT_MS, BUCKETS, now)
          : noAttempts(BUCKETS),
      } satisfies SourceRow;
    });

    const never = sources.filter((source) => source.state === 'never').length;
    return {
      id: 'house',
      title: 'Around the house',
      // Not alarming: the commonest cause is a device unplugged or replaced.
      note: never
        ? 'A device that has never answered was still found, adopted and enabled. That usually ' +
          'means it has been unplugged or replaced rather than that anything is broken, but ' +
          'nothing here can tell which, so it will keep saying so until you remove it.'
        : undefined,
      sources,
    };
  }

  /** Feeds and the box itself: weather, the imported meter, storage, backups. */
  private async feeds(now: Date): Promise<SourceGroup> {
    const [latestWeather, recentWeather, latestBattery, utility] = await Promise.all([
      this.prisma.weatherReading.findFirst({
        orderBy: { takenAt: 'desc' },
        select: { takenAt: true },
      }),
      this.prisma.weatherReading.findMany({
        where: { takenAt: { gte: historyWindow(WEATHER_POLL_MS) } },
        orderBy: { takenAt: 'asc' },
        select: { takenAt: true },
      }),
      this.prisma.batteryReading.findFirst({
        orderBy: { takenAt: 'desc' },
        select: { takenAt: true },
      }),
      this.prisma.utilityReading.findFirst({
        orderBy: { importedAt: 'desc' },
        select: { importedAt: true, source: true },
      }),
    ]);

    const sources: SourceRow[] = [];

    const weatherOn = latestWeather !== null;
    sources.push({
      id: 'weather',
      name: 'Weather & irradiance',
      detail: weatherOn ? 'forecast and actual' : 'no site location set',
      state: stateOf(
        { configured: weatherOn, lastSeenAt: latestWeather?.takenAt ?? null, cadenceMs: WEATHER_POLL_MS },
        now,
      ),
      lastSeenAt: latestWeather?.takenAt.toISOString() ?? null,
      cadenceMs: WEATHER_POLL_MS,
      cadenceText: cadenceText(WEATHER_POLL_MS),
      attempts: weatherOn
        ? attemptsFrom(recentWeather.map((r) => r.takenAt), WEATHER_POLL_MS, BUCKETS, now)
        : noAttempts(BUCKETS),
    });

    // No cadence: fed in by hand, so it cannot be late.
    sources.push({
      id: 'utility',
      name: 'Utility meter',
      detail: utility?.source ? `imported · ${utility.source}` : 'never imported',
      state: stateOf(
        { configured: utility !== null, lastSeenAt: utility?.importedAt ?? null, cadenceMs: null },
        now,
      ),
      lastSeenAt: utility?.importedAt.toISOString() ?? null,
      cadenceMs: null,
      cadenceText: 'you import it',
      attempts: noAttempts(BUCKETS),
    });

    // Hollow rather than a fault: "no data" would suggest a battery failing to answer.
    sources.push({
      id: 'battery',
      name: 'Home battery',
      detail: latestBattery ? 'reporting' : 'none configured',
      state: stateOf(
        { configured: latestBattery !== null, lastSeenAt: latestBattery?.takenAt ?? null, cadenceMs: DEFAULT_POLL_MS },
        now,
      ),
      lastSeenAt: latestBattery?.takenAt.toISOString() ?? null,
      cadenceMs: latestBattery ? DEFAULT_POLL_MS : null,
      cadenceText: latestBattery ? cadenceText(DEFAULT_POLL_MS) : '—',
      attempts: noAttempts(BUCKETS) as Attempt[],
    });

    return { id: 'feeds', title: 'Feeds and storage', sources };
  }
}
