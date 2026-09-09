import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CollectorService } from '../collector/collector.service';
import { SITE_TIMEZONE, localDateOf } from '../common/localdate';
import {
  ADD_OUTPUT_URL,
  ADD_STATUS_URL,
  PvoutputConfig,
  RateState,
  authHeaders,
  canUpload,
  interpret,
  maySpend,
  outputParams,
  readRateState,
  statusParams,
} from './pvoutput-protocol';

/**
 * Sharing this array's output with PVOutput. Participating means publishing, so nothing
 * leaves this machine unless the owner switched it on AND pasted their own key — both
 * conditions live in `canUpload`, and every send path goes through it.
 */

export const PVOUTPUT_ENABLED = 'pvoutput.enabled';
/* Persisted: a restart must not lose the last upload time or why the uploader turned off. */
export const PVOUTPUT_LAST_UPLOAD = 'pvoutput.lastUploadAt';
export const PVOUTPUT_LAST_ERROR = 'pvoutput.lastError';
export const PVOUTPUT_RATE_REMAINING = 'pvoutput.rateRemaining';
export const PVOUTPUT_RATE_RESET = 'pvoutput.rateResetAt';
export const PVOUTPUT_OUTPUT_SENT_FOR = 'pvoutput.outputSentFor';
export const PVOUTPUT_API_KEY = 'pvoutput.apiKey';
export const PVOUTPUT_SYSTEM_ID = 'pvoutput.systemId';

/** Six an hour, inside the third of a 60/hour budget this app allows itself. */
const STATUS_INTERVAL_MS = 10 * 60_000;
/** A minute after boot, so a restart does not sit silent for the first interval. */
const FIRST_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface PvoutputStatus {
  enabled: boolean;
  configured: boolean;
  systemId: string | null;
  lastUploadAt: string | null;
  lastError: string | null;
  rateRemaining: number | null;
}

@Injectable()
export class PvoutputService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PvoutputService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private rate: RateState = { remaining: null, resetAt: null };
  private lastUploadAt: Date | null = null;
  private lastError: string | null = null;
  /** The local date whose daily total has already gone up, so it goes up once. */
  private outputSentFor: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly collector: CollectorService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Restore before the first tick: `maySpend` returns true on a null remaining, so a
    // restart loop would otherwise spend freely.
    const [uploadedAt, error, remaining, resetAt, sentFor] = await Promise.all([
      this.setting(PVOUTPUT_LAST_UPLOAD),
      this.setting(PVOUTPUT_LAST_ERROR),
      this.setting(PVOUTPUT_RATE_REMAINING),
      this.setting(PVOUTPUT_RATE_RESET),
      this.setting(PVOUTPUT_OUTPUT_SENT_FOR),
    ]);
    const when = uploadedAt ? new Date(uploadedAt) : null;
    this.lastUploadAt = when && !Number.isNaN(when.getTime()) ? when : null;
    this.lastError = error;
    this.rate = {
      remaining: remaining === null ? null : Number(remaining),
      resetAt: resetAt === null ? null : Number(resetAt),
    };
    if (!Number.isFinite(this.rate.remaining ?? 0)) this.rate.remaining = null;
    if (!Number.isFinite(this.rate.resetAt ?? 0)) this.rate.resetAt = null;
    this.outputSentFor = sentFor;

    this.first = setTimeout(() => void this.tick(), FIRST_MS);
    this.timer = setInterval(() => void this.tick(), STATUS_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  /** Write, or delete when the value is gone. A stale row is worse than an absent one. */
  private async remember(key: string, value: string | null): Promise<void> {
    if (value === null) {
      await this.prisma.setting.deleteMany({ where: { key } });
      return;
    }
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  private async rememberRate(): Promise<void> {
    await this.remember(
      PVOUTPUT_RATE_REMAINING,
      this.rate.remaining === null ? null : String(this.rate.remaining),
    );
    await this.remember(
      PVOUTPUT_RATE_RESET,
      this.rate.resetAt === null ? null : String(this.rate.resetAt),
    );
  }

  private async setting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  async config(): Promise<PvoutputConfig> {
    const [enabled, apiKey, systemId] = await Promise.all([
      this.setting(PVOUTPUT_ENABLED),
      this.setting(PVOUTPUT_API_KEY),
      this.setting(PVOUTPUT_SYSTEM_ID),
    ]);
    return { enabled: enabled === '1', apiKey, systemId };
  }

  /** The key is never returned in any form — `configured` is the only fact the UI needs. */
  async status(): Promise<PvoutputStatus> {
    const config = await this.config();
    return {
      enabled: config.enabled,
      configured: canUpload({ ...config, enabled: true }),
      systemId: config.systemId,
      lastUploadAt: this.lastUploadAt?.toISOString() ?? null,
      lastError: this.lastError,
      rateRemaining: this.rate.remaining,
    };
  }

  async save(input: { enabled?: boolean; apiKey?: string; systemId?: string }): Promise<void> {
    const write = async (key: string, value: string): Promise<void> => {
      await this.prisma.setting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    };
    // A blank key means "leave it alone": the status endpoint never sends the secret back,
    // so the field renders empty and treating that as a deletion would wipe the key.
    if (input.apiKey !== undefined && input.apiKey.trim()) {
      await write(PVOUTPUT_API_KEY, input.apiKey.trim());
    }
    if (input.systemId !== undefined && input.systemId.trim()) {
      await write(PVOUTPUT_SYSTEM_ID, input.systemId.trim());
    }
    // Refused rather than stored: enabled with no key leaves the switch reading "Uploading
    // every 10 minutes" while nothing is.
    if (input.enabled !== undefined) {
      const stored = await this.config();
      if (input.enabled && !canUpload({ ...stored, enabled: true })) {
        throw new BadRequestException('Enter your PVOutput API key and system id first.');
      }
      await write(PVOUTPUT_ENABLED, input.enabled ? '1' : '0');
    }
    // Only new credentials clear the last failure — `post` disables the uploader by calling
    // this, and would otherwise erase the reason on the way out.
    if (input.apiKey?.trim() || input.systemId?.trim()) {
      this.lastError = null;
      await this.remember(PVOUTPUT_LAST_ERROR, null);
    }
  }

  /** Forget the credentials entirely. The only way to un-enter a key. */
  async forget(): Promise<void> {
    await this.prisma.setting.deleteMany({
      where: { key: { in: [PVOUTPUT_API_KEY, PVOUTPUT_SYSTEM_ID] } },
    });
    await this.save({ enabled: false });
    // Cleared from storage too, or the next restart resurrects a complaint about a key that
    // no longer exists.
    this.lastError = null;
    await this.remember(PVOUTPUT_LAST_ERROR, null);
  }

  private async post(url: string, body: URLSearchParams, config: PvoutputConfig): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: authHeaders(config),
        body: body.toString(),
        signal: controller.signal,
      });
      this.rate = readRateState(response.headers);
      await this.rememberRate();
      const outcome = interpret(response.status, await response.text());
      if (outcome.ok) {
        this.lastUploadAt = new Date();
        this.lastError = null;
        await this.remember(PVOUTPUT_LAST_UPLOAD, this.lastUploadAt.toISOString());
        await this.remember(PVOUTPUT_LAST_ERROR, null);
        return true;
      }
      this.lastError = outcome.reason;
      await this.remember(PVOUTPUT_LAST_ERROR, this.lastError);
      // A permanent refusal turns the uploader off rather than repeating every ten minutes.
      if (!outcome.retryable) {
        await this.save({ enabled: false });
        this.logger.warn(`PVOutput upload disabled: ${outcome.reason}`);
      } else {
        this.logger.warn(`PVOutput upload failed: ${outcome.reason}`);
      }
      return false;
    } catch (error) {
      this.lastError = (error as Error).message;
      await this.remember(PVOUTPUT_LAST_ERROR, this.lastError);
      this.logger.warn(`PVOutput upload failed: ${this.lastError}`);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Site-local HH:MM, matching the date the rest of the app buckets by. */
  private localTime(at: Date): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: SITE_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  }

  private async tick(): Promise<void> {
    const config = await this.config();
    if (!canUpload(config)) return;
    if (!maySpend(this.rate, Date.now())) return;

    const snapshot = this.collector.getLastSnapshot();
    if (!snapshot) return;
    const takenAt = new Date(snapshot.takenAt);
    // Never publish a stale reading as current: the snapshot keeps its old numbers when the
    // gateway stops answering, drawing a flat line on a public graph.
    if (Date.now() - takenAt.getTime() > STATUS_INTERVAL_MS * 2) return;

    const date = localDateOf(takenAt);
    await this.post(
      ADD_STATUS_URL,
      statusParams({
        date,
        time: this.localTime(takenAt),
        energyWh: snapshot.dailyEnergyWh,
        powerW: snapshot.totalPower,
      }),
      config,
    );

    // Yesterday's total, once. Sent separately because PVOutput derives its daily figure
    // from the statuses that arrived, and an outage or rate-limited hour leaves gaps.
    const yesterday = localDateOf(new Date(Date.now() - 86_400_000));
    if (date !== yesterday && this.outputSentFor !== yesterday) {
      const rollup = await this.prisma.dtuReading.aggregate({
        where: { localDate: yesterday },
        _max: { dailyEnergy: true, totalPower: true },
      });
      const generatedWh = rollup._max.dailyEnergy ?? 0;
      if (generatedWh > 0) {
        const sent = await this.post(
          ADD_OUTPUT_URL,
          outputParams({
            date: yesterday,
            generatedWh,
            peakPowerW: rollup._max.totalPower ?? null,
          }),
          config,
        );
        // Marked either way: retrying a refused day spends the whole budget on one date.
        if (sent) {
          this.outputSentFor = yesterday;
          await this.remember(PVOUTPUT_OUTPUT_SENT_FOR, yesterday);
        }
      } else {
        this.outputSentFor = yesterday;
        await this.remember(PVOUTPUT_OUTPUT_SENT_FOR, yesterday);
      }
    }
  }

  /** A real upload, not a dry run: the question is whether a point appears on their page. */
  async testUpload(): Promise<{ ok: boolean; message: string }> {
    const config = await this.config();
    if (!canUpload(config)) {
      return { ok: false, message: 'Enter your API key and system id, and switch it on first.' };
    }
    const snapshot = this.collector.getLastSnapshot();
    if (!snapshot) return { ok: false, message: 'No reading from the array yet to send.' };
    const takenAt = new Date(snapshot.takenAt);
    const ok = await this.post(
      ADD_STATUS_URL,
      statusParams({
        date: localDateOf(takenAt),
        time: this.localTime(takenAt),
        energyWh: snapshot.dailyEnergyWh,
        powerW: snapshot.totalPower,
      }),
      config,
    );
    return ok
      ? { ok: true, message: 'Sent — it should appear on your PVOutput page within a minute.' }
      : { ok: false, message: this.lastError ?? 'Upload failed.' };
  }
}
