import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSnapshot } from '../hoymiles/types';
import { WeatherService } from '../weather/weather.service';
import { ArrayCensusService } from '../system/array-census.service';
import { evaluateSnapshotAlerts } from './alert-rules';
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
    /*
      Tell the debouncer what is already open.

      Its streak map is in-memory, and its close loop iterates that map — so without
      this an alert written before a restart is invisible to it and can never be
      closed. The alerts survive in the database; the knowledge that they are open did
      not, so they sat "active" forever regardless of what the hardware was doing.
    */
    this.debouncer.seed(this.openAlerts.keys());
    return this.openAlerts;
  }

  /**
   * Diff the snapshot's active conditions against open alerts.
   *
   * Three gates now sit between "a rule matched" and "someone's phone buzzes":
   * hysteresis inside the rules, a confirmation streak here, and a notification
   * policy that rations by severity. Previously a single matching poll opened an
   * alert and pushed immediately, which on a partly cloudy afternoon meant sixteen
   * notifications about panels shading each other.
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
    /*
      Census findings join the same pipeline rather than notifying on their own, so they
      inherit the confirmation streak and the notification rationing. They are stable
      facts — an array does not gain panels between polls — so the streak costs nothing
      and protects against a half-populated registry right after a restart being read as
      missing hardware.
    */
    candidates.push(...(await this.census.alertCandidates()));
    const byKey = new Map(candidates.map((c) => [this.conditionKey(c), c]));
    const { toOpen, toClose } = this.debouncer.step(new Set(byKey.keys()));

    /*
      Records are written per condition; notifications are grouped afterwards.

      Keeping those two apart is the point. The Alerts page still needs to say which
      inverter, but a fleet that fails together — sunset, a DTU reboot, a tripped
      breaker — must not turn into one text per unit. Twelve messages in a minute all
      saying the same thing is how someone learns to ignore the thirteenth.
    */
    /*
      Refresh what an already-open alert says.

      An alert was written once and never revisited, so its wording and severity were
      frozen at the moment it opened. A panel that drifts from 27% down to 68% down
      kept the old number, and re-classifying a condition in code had no effect on the
      row already sitting on the page — the standing "1 of 12 reported no data" stayed
      "serious" after we learned it was a reporting gap and not a fault.

      Only the description changes. openedAt and any acknowledgement stay put, because
      this is the same ongoing condition, not a new one.
    */
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
      /*
        The cooldown applies to the group as a whole. Routing on the first key would
        let a re-firing fleet dodge its own cooldown whenever the set of affected
        inverters shifted by one, which is exactly what a flapping DTU does.
      */
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

    /*
      Closing needs the same folding as opening, for the same reason.

      A fleet recovers together too — the sun comes up, the DTU finishes rebooting —
      so a per-key resolution notice just moves the twelve-text problem from dusk to
      dawn. Only conditions whose opening was actually announced are eligible, so a
      silently-digested alert still resolves silently.
    */
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

  /**
   * Hand over everything held back since the last call, and clear it.
   *
   * Returns the text rather than sending it, so the daily summary can fold it into
   * the message it was already going to send. A separate "digest" push would be one
   * more interruption, which is the thing this whole change exists to reduce.
   */
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
