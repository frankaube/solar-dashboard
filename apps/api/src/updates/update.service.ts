import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { BuildInfo, buildInfo } from '../common/build-info';
import { dataDir } from '../common/lite';
import { SITE_TIMEZONE } from '../common/localdate';
import {
  CHANNELS,
  Channel,
  DEFAULT_CHANNEL,
  Release,
  UpdateDecision,
  chooseUpdate,
  currentArch,
  isChannel,
} from './releases';
import { FeedSource, fetchFeed, resolveFeed } from './feed';
import {
  DEFAULT_POLICY,
  POLICY_FILE,
  REQUEST_FILE,
  STATE_FILE,
  UpdatePolicy,
  UpdateState,
  describeState,
  normaliseHour,
  parseState,
  serialisePolicy,
  serialiseRequest,
} from './handoff';

export const UPDATE_CHANNEL_SETTING = 'update.channel';
export const UPDATE_APPLY_SETTING = 'update.apply';
export const UPDATE_HOUR_SETTING = 'update.hour';

/**
 * Polled rather than scheduled: a fired-once timer is lost on a restart. Six hours keeps a
 * reboot from pushing the next look a day out, at four requests against GitHub's 60/hour.
 */
const CHECK_INTERVAL_MS = 6 * 3_600_000;
/** Long enough after boot for the collector and migrations to have the machine. */
const FIRST_CHECK_DELAY_MS = 90_000;

export interface UpdateStatus {
  current: BuildInfo;
  channel: Channel;
  channels: typeof CHANNELS;
  apply: boolean;
  hour: number;
  timeZone: string;
  arch: string;
  source: FeedSource;
  configured: boolean;
  available: {
    version: string;
    publishedAt: string | null;
    notesUrl: string | null;
    notes: string | null;
    sizeBytes: number | null;
  } | null;
  /** Always a sentence. */
  reason: string;
  blocked: boolean;
  checkedAt: string | null;
  checkError: string | null;
  lastAttempt: UpdateState | null;
  lastAttemptText: string | null;
  /** An install this app asked for that the updater has not consumed yet. */
  pending: string | null;
}

@Injectable()
export class UpdateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpdateService.name);
  private timer: NodeJS.Timeout | null = null;
  private decision: UpdateDecision | null = null;
  private checkedAt: string | null = null;
  private checkError: string | null = null;
  private checking = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Mirror what is stored, so the updater has a policy even if the UI is never opened.
    await this.writePolicy(await this.policy()).catch(() => undefined);
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async setting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  private async set(key: string, value: string): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  /** The database is the source of truth; the file beside it is a mirror for the updater. */
  async policy(): Promise<UpdatePolicy> {
    const [channel, apply, hour] = await Promise.all([
      this.setting(UPDATE_CHANNEL_SETTING),
      this.setting(UPDATE_APPLY_SETTING),
      this.setting(UPDATE_HOUR_SETTING),
    ]);
    return {
      channel: isChannel(channel) ? channel : DEFAULT_CHANNEL,
      apply: apply === 'true',
      hour: normaliseHour(hour),
    };
  }

  private path(name: string): string {
    return join(dataDir(), name);
  }

  private async writePolicy(policy: UpdatePolicy): Promise<void> {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(this.path(POLICY_FILE), serialisePolicy(policy), 'utf8');
  }

  async savePolicy(input: {
    channel?: unknown;
    apply?: unknown;
    hour?: unknown;
  }): Promise<UpdatePolicy> {
    const current = await this.policy();
    const next: UpdatePolicy = {
      channel: isChannel(input.channel) ? input.channel : current.channel,
      apply: input.apply === undefined ? current.apply : input.apply === true || input.apply === 'true',
      hour: input.hour === undefined ? current.hour : normaliseHour(input.hour, current.hour),
    };
    await Promise.all([
      this.set(UPDATE_CHANNEL_SETTING, next.channel),
      this.set(UPDATE_APPLY_SETTING, String(next.apply)),
      this.set(UPDATE_HOUR_SETTING, String(next.hour)),
    ]);
    await this.writePolicy(next);

    // Off must also clear a pending request, or an install stays queued for the next tick.
    if (next.channel === 'off') {
      await this.clearRequest();
      this.decision = null;
    }
    // Awaited: otherwise the response is built from the previous decision, which on a first
    // switch to a real channel is none at all.
    await this.check();
    return next;
  }

  private async readJson<T>(name: string, parse: (body: string) => T): Promise<T | null> {
    try {
      return parse(await readFile(this.path(name), 'utf8'));
    } catch {
      // Absent is the normal case, and unreadable must not break the status endpoint.
      return null;
    }
  }

  async lastAttempt(): Promise<UpdateState | null> {
    return this.readJson(STATE_FILE, parseState);
  }

  async pending(): Promise<string | null> {
    const request = await this.readJson(REQUEST_FILE, (body) => {
      const raw = JSON.parse(body) as { version?: unknown };
      return typeof raw.version === 'string' ? raw.version : null;
    });
    return request ?? null;
  }

  private async clearRequest(): Promise<void> {
    await unlink(this.path(REQUEST_FILE)).catch(() => undefined);
  }

  /** Never throws: the caller is as often a timer as a request. */
  async check(): Promise<UpdateDecision> {
    if (this.checking) return this.decision ?? { release: null, assets: null, reason: 'Checking…', blocked: false };
    this.checking = true;
    try {
      const policy = await this.policy();
      const source = resolveFeed();
      if (policy.channel === 'off') {
        // Off means no outbound request at all.
        this.decision = chooseUpdate({ current: buildInfo(), releases: [], channel: 'off' });
        this.checkError = null;
        return this.decision;
      }
      const feed = await fetchFeed(source);
      this.checkedAt = feed.checkedAt;
      this.checkError = feed.error;
      this.decision = chooseUpdate({
        current: buildInfo(),
        releases: feed.releases,
        channel: policy.channel,
      });
      if (this.decision.release) {
        this.logger.log(`update available: ${this.decision.release.version}`);
      } else if (feed.error) {
        this.logger.warn(`update check failed: ${feed.error}`);
      }
      return this.decision;
    } finally {
      this.checking = false;
    }
  }

  /**
   * Checked against a fresh look at the feed before the request is written, and by the
   * updater again against its own resolution — this is the call that leads to root replacing
   * a binary.
   */
  async requestInstall(version: unknown): Promise<{ ok: boolean; message: string }> {
    const wanted = typeof version === 'string' ? version.trim().replace(/^v/, '') : '';
    if (!wanted) return { ok: false, message: 'No version given.' };

    const decision = await this.check();
    if (!decision.release) {
      return { ok: false, message: decision.reason };
    }
    if (decision.release.version !== wanted) {
      return {
        ok: false,
        message: `${wanted} is not the release on offer (${decision.release.version}). Nothing was queued.`,
      };
    }

    await mkdir(dataDir(), { recursive: true });
    await writeFile(
      this.path(REQUEST_FILE),
      serialiseRequest({ version: decision.release.version, requestedAt: new Date().toISOString() }),
      'utf8',
    );
    this.logger.log(`install of ${decision.release.version} queued for the updater`);
    return {
      ok: true,
      message: `${decision.release.version} is queued. The updater installs it on its next run.`,
    };
  }

  async cancelInstall(): Promise<void> {
    await this.clearRequest();
  }

  private describeRelease(release: Release, sizeBytes: number | null): UpdateStatus['available'] {
    return {
      version: release.version,
      publishedAt: release.publishedAt,
      notesUrl: release.notesUrl,
      notes: release.notes,
      sizeBytes,
    };
  }

  async status(): Promise<UpdateStatus> {
    const [policy, lastAttempt, pending] = await Promise.all([
      this.policy(),
      this.lastAttempt(),
      this.pending(),
    ]);
    const source = resolveFeed();
    // "Not looked yet" must stay distinguishable from "looked and found nothing".
    const decision: UpdateDecision =
      this.decision ??
      (policy.channel === 'off'
        ? chooseUpdate({ current: buildInfo(), releases: [], channel: 'off' })
        : { release: null, assets: null, reason: 'Not checked yet.', blocked: false });
    return {
      current: buildInfo(),
      channel: policy.channel,
      channels: CHANNELS,
      apply: policy.apply,
      hour: policy.hour,
      timeZone: SITE_TIMEZONE,
      arch: currentArch(),
      source,
      configured: source.kind !== 'none',
      available: decision.release
        ? this.describeRelease(decision.release, decision.assets?.bundle.sizeBytes ?? null)
        : null,
      reason: decision.reason,
      blocked: decision.blocked,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      lastAttempt,
      lastAttemptText: describeState(lastAttempt),
      pending,
    };
  }
}
