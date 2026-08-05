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
 * Sharing this array's output with PVOutput, if and only if the owner asks.
 *
 * PVOutput is the long-running public register of domestic solar — it is what makes "is
 * 76 kWh a good day for 23 kW in this climate" answerable at all, because the comparison
 * needs other people's roofs and nothing else aggregates them. That value is real, and it
 * is also the reason this needs care: participating means publishing.
 *
 * So the rule the whole file is built around is that nothing leaves this machine unless
 * the owner switched it on AND pasted their own key. Both conditions live in `canUpload`,
 * every send path goes through it, and there is no code path that infers consent from
 * anything else.
 */

export const PVOUTPUT_ENABLED = 'pvoutput.enabled';
export const PVOUTPUT_API_KEY = 'pvoutput.apiKey';
export const PVOUTPUT_SYSTEM_ID = 'pvoutput.systemId';

/**
 * How often a live status goes up.
 *
 * Ten minutes: PVOutput's own default status interval is five, and at a third of a
 * 60-per-hour budget this app may spend twenty an hour — six is comfortably inside it and
 * leaves room for the daily total and for whatever else the owner runs on the same key.
 */
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

  onModuleInit(): void {
    this.first = setTimeout(() => void this.tick(), FIRST_MS);
    this.timer = setInterval(() => void this.tick(), STATUS_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
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

  /**
   * What Settings shows.
   *
   * The key is never returned, in any form — not masked, not truncated. A settings page
   * that echoes a secret back puts it in the response body of an endpoint that has no
   * business carrying it, and "configured" is the only fact the UI actually needs.
   */
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
    /*
      A blank key means "leave it alone", not "clear it". The field renders empty because
      the status endpoint refuses to send the secret back, so treating empty as a deletion
      would wipe the key every time somebody toggled the switch and pressed Save.
    */
    if (input.apiKey !== undefined && input.apiKey.trim()) {
      await write(PVOUTPUT_API_KEY, input.apiKey.trim());
    }
    if (input.systemId !== undefined && input.systemId.trim()) {
      await write(PVOUTPUT_SYSTEM_ID, input.systemId.trim());
    }
    /*
      Switching on without credentials is refused rather than stored.

      `canUpload` would stop anything being sent either way, so this is not a safety gate —
      it is an honesty one. Storing enabled=true against no key leaves the switch reading
      "Uploading every 10 minutes" while nothing is, which is the kind of state somebody
      only discovers weeks later when they wonder why their PVOutput page is empty.
    */
    if (input.enabled !== undefined) {
      const stored = await this.config();
      if (input.enabled && !canUpload({ ...stored, enabled: true })) {
        throw new BadRequestException('Enter your PVOutput API key and system id first.');
      }
      await write(PVOUTPUT_ENABLED, input.enabled ? '1' : '0');
    }
    /*
      Only new credentials clear the last failure — a new key deserves a clean slate, and
      the old error said nothing about it.

      Not on every save. `post` disables the uploader when the far end refuses for good,
      and it does that by calling this; clearing unconditionally would erase the reason on
      the way out and leave the switch off with nothing on screen explaining why.
    */
    if (input.apiKey?.trim() || input.systemId?.trim()) this.lastError = null;
  }

  /** Forget the credentials entirely. The only way to un-enter a key. */
  async forget(): Promise<void> {
    await this.prisma.setting.deleteMany({
      where: { key: { in: [PVOUTPUT_API_KEY, PVOUTPUT_SYSTEM_ID] } },
    });
    await this.save({ enabled: false });
    // Nothing is configured any more, so a failure about the old key describes nothing.
    this.lastError = null;
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
      const outcome = interpret(response.status, await response.text());
      if (outcome.ok) {
        this.lastUploadAt = new Date();
        this.lastError = null;
        return true;
      }
      this.lastError = outcome.reason;
      /*
        A refusal that will not change turns the uploader off rather than repeating itself
        every ten minutes forever. The owner has to look at the settings page anyway to fix
        a wrong key, and that is where the reason is waiting.
      */
      if (!outcome.retryable) {
        await this.save({ enabled: false });
        this.logger.warn(`PVOutput upload disabled: ${outcome.reason}`);
      } else {
        this.logger.warn(`PVOutput upload failed: ${outcome.reason}`);
      }
      return false;
    } catch (error) {
      this.lastError = (error as Error).message;
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
    /*
      Never publish a stale reading as a current one. If the gateway has stopped answering,
      the last snapshot keeps its old numbers and uploading them would draw a flat line on
      a public graph that says the array is producing when it is not.
    */
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

    /*
      Yesterday's total, once, after the day has closed.

      Sent separately from the statuses because PVOutput derives a daily figure from them
      and that derivation is only as good as the statuses that arrived — a restart, an
      outage, or a rate-limited hour leaves gaps. The day's own total is the number this
      app is sure of.
    */
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
        // Marked either way: a refusal is recorded and surfaced, and retrying a day the
        // far end would not take is how an uploader spends its whole budget on one date.
        if (sent) this.outputSentFor = yesterday;
      } else {
        this.outputSentFor = yesterday;
      }
    }
  }

  /**
   * Send one status now, for the owner to confirm the key works.
   *
   * Deliberately a real upload rather than a dry run: "the credentials parse" is not the
   * question anybody has. The question is whether a point appears on their PVOutput page,
   * and only sending one answers it.
   */
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
