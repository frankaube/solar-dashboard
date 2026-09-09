import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSnapshot } from '../hoymiles/types';
import { WeatherService } from '../weather/weather.service';
import { ArrayCensusService } from '../system/array-census.service';
import { evaluateSnapshotAlerts } from './alert-rules';
import { CHARGER_HOST_SETTING } from '../charger/charger.service';
import { SourceHealth, evaluateSourceSilence } from './source-silence';
import { evaluateUtilityStaleness } from './utility-staleness';
import { evaluateUnmeteredExport } from './unmetered-export';
import {
  ConditionDebouncer,
  DigestEntry,
  buildDigest,
  coalesceNotifications,
  routeClose,
  routeOpen,
} from './alert-policy';
import { NotifierService } from './notifier.service';

const RECENT_CLOSED_LIMIT = 20;

export interface AlertDto {
  id: number;
  type: string;
  severity: string;
  subjectKey: string;
  message: string;
  openedAt: Date;
  closedAt: Date | null;
  ackedAt: Date | null;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  /** condition key (type|subject) → open alert row */
  private openAlerts: Map<string, { id: number; message: string; severity: string }> | null = null;
  private readonly debouncer = new ConditionDebouncer();
  /** Last immediate push per condition, so a flapping serious alert cannot spam. */
  private readonly lastNotifiedAt = new Map<string, number>();
  /** Conditions whose opening was actually pushed — only these get a resolution notice. */
  private readonly notifiedOpen = new Set<string>();
  private digest: DigestEntry[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: NotifierService,
    private readonly weather: WeatherService,
    private readonly census: ArrayCensusService,
  ) {}

  /** From the readings, not in-memory state: a restart would make a dead source look fresh. */
  private async sourceHealth(): Promise<SourceHealth[]> {
    const chargerHost = await this.prisma.setting.findUnique({
      where: { key: CHARGER_HOST_SETTING },
    });
    const configured = Boolean(chargerHost?.value || process.env.CHARGER_HOST);
    if (!configured) return [];
    const latest = await this.prisma.chargerReading.findFirst({
      orderBy: { takenAt: 'desc' },
      select: { takenAt: true },
    });
    return [
      {
        key: 'charger',
        label: 'The EV charger',
        lastSeenAt: latest?.takenAt ?? null,
        intervalMs: 30_000,
        configured: true,
      },
    ];
  }

  private conditionKey(candidate: { type: string; subjectKey: string }): string {
    return `${candidate.type}|${candidate.subjectKey}`;
  }

  private async loadOpenAlerts(): Promise<Map<string, { id: number; message: string; severity: string }>> {
    if (this.openAlerts) return this.openAlerts;
    const rows = await this.prisma.alert.findMany({ where: { closedAt: null } });
    this.openAlerts = new Map(
      rows.map((row) => [
        this.conditionKey(row),
        { id: row.id, message: row.message, severity: row.severity },
      ]),
    );
    // Its close loop iterates an in-memory map, so an unseeded pre-restart alert never closes.
    this.debouncer.seed(this.openAlerts.keys());
    return this.openAlerts;
  }

  /**
   * Diff active conditions against open alerts. Three gates sit between a rule matching
   * and a push: hysteresis in the rules, a confirmation streak here, severity rationing.
   */
  async processSnapshot(
    snapshot: SystemSnapshot,
    expectedInverterCount: number | null,
  ): Promise<void> {
    const open = await this.loadOpenAlerts();
    const current = this.weather.getWeather().current;
    const candidates = evaluateSnapshotAlerts(
      snapshot,
      expectedInverterCount,
      current
        ? { irradianceWm2: current.shortwaveRadiation, temperatureC: current.temperature }
        : null,
      // Hysteresis needs to know what is already open.
      new Set(open.keys()),
    );
    // Same pipeline, so census findings inherit the streak — which guards against a
    // half-populated registry after a restart reading as missing hardware.
    candidates.push(...(await this.census.alertCandidates()));

    candidates.push(...evaluateSourceSilence(await this.sourceHealth(), new Date()));
    // Nothing here can fetch utility data — the portals are behind logins.
    const newestUtility = await this.prisma.utilityReading.findFirst({
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    candidates.push(
      ...evaluateUtilityStaleness({ newestDate: newestUtility?.date ?? null }, new Date()),
    );
    // Energy leaving unpaid: only days still touching the end of the record qualify.
    if (newestUtility) {
      const flagged = await this.prisma.utilityReading.findMany({
        where: { unmetered: true },
        select: { date: true },
      });
      // As `getDailyEnergy` derives it: the day's total is the max of a counter that decays
      // after sunset. Queried here because ReadingsModule imports this one.
      const produced = flagged.length
        ? await this.prisma.dtuReading.groupBy({
            by: ['localDate'],
            where: { localDate: { in: flagged.map((row) => row.date) } },
            _max: { dailyEnergy: true },
          })
        : [];
      const wh = new Map(produced.map((row) => [row.localDate, row._max.dailyEnergy ?? 0]));
      candidates.push(
        ...evaluateUnmeteredExport({
          newestDate: newestUtility.date,
          unmetered: flagged.map((row) => ({
            date: row.date,
            producedKwh: (wh.get(row.date) ?? 0) / 1000,
          })),
        }),
      );
    }
    const byKey = new Map(candidates.map((c) => [this.conditionKey(c), c]));
    const { toOpen, toClose } = this.debouncer.step(new Set(byKey.keys()));

    // Refresh an open alert's wording and severity. openedAt and any acknowledgement stay
    // put, since this is the same ongoing condition.
    for (const [key, candidate] of byKey) {
      const existing = open.get(key);
      if (!existing) continue;
      if (existing.message === candidate.message && existing.severity === candidate.severity) {
        continue;
      }
      await this.prisma.alert.update({
        where: { id: existing.id },
        data: { message: candidate.message, severity: candidate.severity },
      });
      open.set(key, {
        id: existing.id,
        message: candidate.message,
        severity: candidate.severity,
      });
      this.logger.log(`Alert ${existing.id} updated [${candidate.severity}] ${candidate.message}`);
    }

    const openedNow: Array<{ key: string; candidate: (typeof candidates)[number] }> = [];
    for (const key of toOpen) {
      const candidate = byKey.get(key);
      if (!candidate || open.has(key)) continue;
      const row = await this.prisma.alert.create({
        data: {
          type: candidate.type,
          severity: candidate.severity,
          subjectKey: candidate.subjectKey,
          message: candidate.message,
        },
      });
      open.set(key, { id: row.id, message: row.message, severity: row.severity });
      this.logger.warn(`Alert opened [${candidate.severity}] ${candidate.message}`);
      openedNow.push({ key, candidate });
    }

    const now = Date.now();
    for (const group of coalesceNotifications(
      openedNow.map(({ key, candidate }) => ({
        type: candidate.type,
        severity: candidate.severity,
        // The condition key, not the raw subject — that is what the cooldown tracks.
        subjectKey: key,
        message: candidate.message,
      })),
    )) {
      // Cooldown applies to the group: routing on the first key would let a re-firing
      // fleet dodge it whenever the affected set shifted by one.
      const lastNotified = group.keys
        .map((k) => this.lastNotifiedAt.get(k))
        .filter((t): t is number => t !== undefined);
      const channel = routeOpen({
        severity: group.severity,
        subjectKey: group.keys[0],
        lastNotifiedAt: lastNotified.length === group.keys.length ? Math.max(...lastNotified) : undefined,
        now,
      });
      if (channel === 'immediate') {
        for (const k of group.keys) {
          this.lastNotifiedAt.set(k, now);
          this.notifiedOpen.add(k);
        }
        await this.notifier.send(`⚠️ ${group.message}`);
      } else if (channel === 'digest') {
        this.digest.push({ severity: group.severity, message: group.message });
      }
    }

    // Closing folds like opening. Only announced openings are eligible, so a digested
    // alert resolves silently.
    const resolved: Array<{ key: string; message: string }> = [];
    for (const key of toClose) {
      const entry = open.get(key);
      if (!entry) continue;
      await this.prisma.alert.update({ where: { id: entry.id }, data: { closedAt: new Date() } });
      open.delete(key);
      this.logger.log(`Alert ${entry.id} closed (condition cleared)`);
      if (routeClose(this.notifiedOpen.has(key)) === 'immediate') {
        resolved.push({ key, message: entry.message });
      }
      this.notifiedOpen.delete(key);
    }

    for (const group of coalesceNotifications(
      resolved.map(({ key, message }) => ({
        // The condition key is `type|subject`; recover the type so like folds with like.
        type: key.split('|')[0],
        severity: 'warning' as const,
        subjectKey: key,
        message,
      })),
    )) {
      await this.notifier.send(`✅ Resolved: ${group.message}`);
    }
  }

  /** Returns the text rather than sending it, so the daily summary folds it into its own. */
  async takeDigest(): Promise<string | null> {
    const text = buildDigest(this.digest);
    this.digest = [];
    return text;
  }

  /** Pending digest size — for diagnostics and tests. */
  digestSize(): number {
    return this.digest.length;
  }

  async getAlerts(): Promise<{ active: AlertDto[]; recentlyClosed: AlertDto[] }> {
    const active = await this.prisma.alert.findMany({
      where: { closedAt: null },
      orderBy: { openedAt: 'desc' },
    });
    const recentlyClosed = await this.prisma.alert.findMany({
      where: { closedAt: { not: null } },
      orderBy: { closedAt: 'desc' },
      take: RECENT_CLOSED_LIMIT,
    });
    return { active, recentlyClosed };
  }

  async countOpen(): Promise<number> {
    return this.prisma.alert.count({ where: { closedAt: null } });
  }

  async acknowledge(id: number): Promise<void> {
    await this.prisma.alert.update({ where: { id }, data: { ackedAt: new Date() } });
  }
}
