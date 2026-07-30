import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SITE_TIMEZONE } from '../common/localdate';
import {
  BackupDestination,
  DESTINATION_KINDS,
  StoredBackup,
  findDestinationKind,
} from './destinations';
import { driveAuthUrl, exchangeCodeForRefreshToken } from './google-drive';
import {
  DEFAULT_FREQUENCY,
  DEFAULT_HOUR,
  describeSchedule,
  findFrequency,
  isDue,
  normaliseHour,
} from './schedule';

export const BACKUP_KIND_SETTING = 'backup.kind';
export const BACKUP_SCHEDULE_SETTING = 'backup.schedule';
export const BACKUP_KEEP_SETTING = 'backup.keep';
export const BACKUP_HOUR_SETTING = 'backup.hour';
/**
 * Which destinations are switched on, comma separated.
 *
 * One instance per kind rather than an arbitrary list, which keeps every existing
 * `backup.<kind>.<field>` key working untouched. Two S3 buckets is not a thing anyone
 * has asked for; a card AND a bucket is exactly what a Pi wants.
 */
const ENABLED_SETTING = 'backup.enabled';

/**
 * Run state, per destination.
 *
 * Namespaced under `state` so it can never collide with a field a destination declares
 * — a kind with a field called `lastOk` would otherwise overwrite its own history.
 *
 * Per destination rather than global because the whole point of two of them is that they
 * fail independently. A bucket that was unreachable at 03:00 must retry while the card
 * that already succeeded must not, and a single shared timestamp cannot express that.
 */
function stateKey(kind: string, field: string): string {
  return `backup.state.${kind}.${field}`;
}
/** Pre-multi-destination installs kept one global success time under this key. */
const LEGACY_SUCCESS_SETTING = 'backup.lastRunAt';

/** Namespaced per destination kind so switching does not inherit stale values. */
export function backupSettingKey(kind: string, field: string): string {
  return `backup.${kind}.${field}`;
}

const CHECK_INTERVAL_MS = 15 * 60_000;
const DEFAULT_KEEP = 14;
/** Long enough to read a consent screen, short enough that a stale link is dead. */
const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** Whatever the frequency registry offers. Validated against it, not against a union. */
export type BackupSchedule = string;

export interface DestinationStatus {
  kind: string;
  name: string;
  describe: string;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  lastSizeBytes: number | null;
  /** Why the stored-backup list is missing, if it could not be read. */
  listError: string | null;
  backups: Array<{ name: string; sizeBytes: number; modifiedAt: string }>;
}

export interface BackupStatus {
  /** Kinds switched on, whether or not they are fully configured. */
  enabled: string[];
  configured: boolean;
  schedule: BackupSchedule;
  hour: number;
  scheduleText: string;
  keep: number;
  destinations: DestinationStatus[];
}

@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    /*
      Checked every 15 minutes rather than scheduled with a cron expression. The app
      restarts — for a deploy, or because the host rebooted — and a fired-once timer
      would silently never fire again. Comparing "when did we last succeed" against
      "how often should we" survives any number of restarts, and skips at most one
      quarter-hour.
    */
    this.timer = setInterval(() => void this.runIfDue(), CHECK_INTERVAL_MS);
    setTimeout(() => void this.runIfDue(), 60_000).unref();
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

  /**
   * Which destinations are switched on.
   *
   * Falls back to the single `backup.kind` an older install stored, so upgrading does
   * not quietly switch backups off — which would be the worst possible way to learn that
   * this feature changed shape.
   */
  async enabledKinds(): Promise<string[]> {
    const raw = await this.setting(ENABLED_SETTING);
    if (raw !== null) {
      return raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => Boolean(findDestinationKind(id)));
    }
    const legacy = await this.setting(BACKUP_KIND_SETTING);
    return findDestinationKind(legacy) ? [legacy as string] : [];
  }

  private async destinationFor(kindId: string): Promise<BackupDestination | null> {
    const kind = findDestinationKind(kindId);
    if (!kind) return null;
    const config: Record<string, string> = {};
    for (const field of kind.fields) {
      const value = await this.setting(backupSettingKey(kind.id, field.key));
      if (value) config[field.key] = value;
    }
    return kind.create(config);
  }

  /** Every enabled destination that is actually usable, paired with its kind id. */
  private async activeDestinations(): Promise<Array<{ kindId: string; dest: BackupDestination }>> {
    const out: Array<{ kindId: string; dest: BackupDestination }> = [];
    for (const kindId of await this.enabledKinds()) {
      const dest = await this.destinationFor(kindId);
      if (dest) out.push({ kindId, dest });
    }
    return out;
  }

  /**
   * A consistent copy of the database, as bytes.
   *
   * VACUUM INTO rather than a file copy: the collector writes every five minutes, and
   * copying a live SQLite file can capture a torn page — producing a backup that looks
   * fine and only fails when you try to restore it, which is the worst possible time to
   * discover it.
   *
   * TeslaMate's Postgres is deliberately NOT included. It lives in a separate container
   * this process cannot reach, and pretending to back it up would be worse than saying
   * plainly that it is not covered.
   */
  async snapshot(): Promise<{ name: string; data: Buffer }> {
    const dbPath = (process.env.DATABASE_URL ?? 'file:/data/solar.db').replace(/^file:/, '');
    const temp = path.join(path.dirname(dbPath), `backup-${process.pid}.tmp`);
    await fs.rm(temp, { force: true });
    try {
      await this.prisma.$executeRawUnsafe(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
      const data = await fs.readFile(temp);
      return { name: `solar-${stamp(new Date())}.db`, data };
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  /**
   * Run a backup now, to every enabled destination (or just the ones named).
   *
   * ONE snapshot, fanned out. VACUUM INTO is the expensive part and the bytes are
   * identical, so snapshotting per destination would double the cost to produce the same
   * file twice — and worse, two snapshots taken a second apart are not the same backup,
   * which makes "are my copies identical?" unanswerable.
   *
   * Each destination succeeds or fails alone. A bucket being unreachable must not stop
   * the card from getting its copy, and must not mark the card's copy as failed.
   */
  async runNow(only?: string[]): Promise<{
    ok: boolean;
    name?: string;
    results: Array<{ kind: string; ok: boolean; sizeBytes?: number; error?: string }>;
    error?: string;
  }> {
    if (this.running) return { ok: false, error: 'A backup is already running', results: [] };
    const targets = (await this.activeDestinations()).filter(
      (t) => !only || only.includes(t.kindId),
    );
    if (!targets.length) {
      return { ok: false, error: 'No backup destination configured', results: [] };
    }

    this.running = true;
    try {
      const { name, data } = await this.snapshot();
      const results: Array<{ kind: string; ok: boolean; sizeBytes?: number; error?: string }> = [];
      for (const { kindId, dest } of targets) {
        const at = new Date();
        try {
          await dest.put(name, data);
          await this.prune(dest);
          await this.set(stateKey(kindId, 'lastRunAt'), at.toISOString());
          await this.recordAttempt(kindId, at, true, null, data.length);
          this.logger.log(
            `Backup ${name} (${(data.length / 1e6).toFixed(1)} MB) → ${dest.describe()}`,
          );
          results.push({ kind: kindId, ok: true, sizeBytes: data.length });
        } catch (error) {
          const message = (error as Error).message;
          await this.recordAttempt(kindId, at, false, message, null);
          this.logger.warn(`Backup to ${kindId} failed: ${message}`);
          results.push({ kind: kindId, ok: false, error: message });
        }
      }
      return { ok: results.some((r) => r.ok), name, results };
    } catch (error) {
      /*
        Only a failure to produce the snapshot at all lands here, and it is not any one
        destination's fault — so it is recorded against every target rather than silently
        leaving them all looking untried.
      */
      const message = (error as Error).message;
      const at = new Date();
      for (const { kindId } of targets) await this.recordAttempt(kindId, at, false, message, null);
      this.logger.warn(`Backup failed before upload: ${message}`);
      return { ok: false, error: message, results: [] };
    } finally {
      this.running = false;
    }
  }

  /**
   * Delete the oldest beyond the keep count.
   *
   * Pruning happens AFTER a successful upload, never before. Deleting first would mean
   * a failed upload leaves fewer backups than there were — the one moment you would
   * most want the old ones intact.
   */
  private async prune(dest: BackupDestination): Promise<void> {
    const keep = Number(await this.setting(BACKUP_KEEP_SETTING)) || DEFAULT_KEEP;
    const existing = await dest.list();
    for (const old of existing.slice(keep)) {
      await dest.remove(old.name);
      this.logger.log(`Pruned old backup ${old.name}`);
    }
  }

  private async recordAttempt(
    kindId: string,
    at: Date,
    ok: boolean,
    error: string | null,
    sizeBytes: number | null,
  ): Promise<void> {
    await this.set(stateKey(kindId, 'lastAttemptAt'), at.toISOString());
    await this.set(stateKey(kindId, 'lastOk'), ok ? '1' : '0');
    await this.set(stateKey(kindId, 'lastError'), error ?? '');
    await this.set(stateKey(kindId, 'lastSizeBytes'), sizeBytes === null ? '' : String(sizeBytes));
  }

  /** The last time this destination actually received a backup. */
  private async lastSuccessFor(kindId: string): Promise<Date | null> {
    const own = await this.setting(stateKey(kindId, 'lastRunAt'));
    // An upgraded install has history under the old global key; without this every
    // destination would read as never-backed-up and all fire at once on first boot.
    const raw = own ?? (await this.setting(LEGACY_SUCCESS_SETTING));
    return raw ? new Date(raw) : null;
  }

  private async runIfDue(): Promise<void> {
    const frequency = (await this.setting(BACKUP_SCHEDULE_SETTING)) ?? DEFAULT_FREQUENCY;
    const hour = normaliseHour(await this.setting(BACKUP_HOUR_SETTING));
    const now = new Date();
    const due: string[] = [];
    for (const { kindId } of await this.activeDestinations()) {
      const lastSuccess = await this.lastSuccessFor(kindId);
      if (isDue({ now, lastSuccess, frequency, hour })) due.push(kindId);
    }
    if (due.length) await this.runNow(due);
  }

  async status(): Promise<BackupStatus> {
    const schedule = (await this.setting(BACKUP_SCHEDULE_SETTING)) ?? DEFAULT_FREQUENCY;
    const hour = normaliseHour(await this.setting(BACKUP_HOUR_SETTING));
    const enabled = await this.enabledKinds();

    const destinations: DestinationStatus[] = [];
    for (const kindId of enabled) {
      const dest = await this.destinationFor(kindId);
      if (!dest) continue;
      let backups: StoredBackup[] = [];
      let listError: string | null = null;
      try {
        backups = await dest.list();
      } catch (error) {
        /*
          Reported separately from the last run's outcome, not folded into it. An empty
          list because the destination is unreachable and an empty list because nothing
          has been backed up yet look identical, and only one of them is fine — so the
          card has to be able to say which. Not a 500: the rest of the status is valid.
        */
        listError = (error as Error).message;
      }
      const ok = await this.setting(stateKey(kindId, 'lastOk'));
      const size = await this.setting(stateKey(kindId, 'lastSizeBytes'));
      destinations.push({
        kind: kindId,
        name: findDestinationKind(kindId)?.name ?? kindId,
        describe: dest.describe(),
        lastRunAt: await this.setting(stateKey(kindId, 'lastAttemptAt')),
        lastOk: ok === null ? null : ok === '1',
        lastError: (await this.setting(stateKey(kindId, 'lastError'))) || null,
        lastSizeBytes: size ? Number(size) : null,
        listError,
        backups: backups.map((backup) => ({
          name: backup.name,
          sizeBytes: backup.sizeBytes,
          modifiedAt: backup.modifiedAt.toISOString(),
        })),
      });
    }

    return {
      enabled,
      configured: destinations.length > 0,
      schedule,
      hour,
      scheduleText: describeSchedule(schedule, hour),
      keep: Number(await this.setting(BACKUP_KEEP_SETTING)) || DEFAULT_KEEP,
      destinations,
    };
  }

  /** Try a destination without storing it: uploads a marker and deletes it again. */
  async test(kindId: string, config: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    const kind = findDestinationKind(kindId);
    if (!kind) return { ok: false, error: `Unknown destination: ${kindId}` };
    /*
      Blank fields fall back to what is already stored for this same kind. The UI never
      sends a secret back down, so without this, testing a saved S3 destination would
      report "missing fields" until you retyped the key you had already entered — which
      reads as the destination being broken rather than the form being coy.
    */
    const merged: Record<string, string> = {};
    for (const field of kind.fields) {
      const typed = config[field.key];
      merged[field.key] =
        typed !== undefined && typed !== ''
          ? typed
          : ((await this.setting(backupSettingKey(kind.id, field.key))) ?? '');
    }
    const dest = kind.create(merged);
    if (!dest) return { ok: false, error: 'Missing required fields' };
    const probe = `solar-writetest-${Date.now()}.db`;
    try {
      await dest.put(probe, Buffer.from('solar-dashboard write test'));
      await dest.list();
      await dest.remove(probe);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /**
   * Save the whole backup configuration in one go.
   *
   * Everything at once rather than per destination, because the schedule and retention
   * are shared: saving them alongside one destination would make the last card you
   * touched silently win.
   */
  async saveConfig(input: {
    enabled: string[];
    configs: Record<string, Record<string, string>>;
    schedule: BackupSchedule;
    keep: number;
    hour?: number;
  }): Promise<void> {
    if (!findFrequency(input.schedule)) throw new Error(`Unknown frequency: ${input.schedule}`);
    const enabled = input.enabled.filter((id) => Boolean(findDestinationKind(id)));

    for (const [kindId, config] of Object.entries(input.configs ?? {})) {
      const kind = findDestinationKind(kindId);
      if (!kind) continue;
      /*
        A refresh token belongs to the OAuth client that issued it. Pointing the same
        destination at a different client ID and keeping the old token gives you a
        destination that looks connected and fails with `invalid_grant` at 3 AM, so the
        authorisation is dropped and has to be granted again — visibly, in the UI.
      */
      if (kindId === 'gdrive') {
        const typed = config.clientId?.trim();
        const stored = await this.setting(backupSettingKey('gdrive', 'clientId'));
        if (typed && stored && typed !== stored) {
          await this.set(backupSettingKey('gdrive', 'refreshToken'), '');
        }
      }
      for (const field of kind.fields) {
        const value = config[field.key];
        // Blank secret means "keep what is stored", so editing one field does not wipe a key.
        if (value === undefined || (field.secret && value === '')) continue;
        await this.set(backupSettingKey(kindId, field.key), value);
      }
    }

    await this.set(ENABLED_SETTING, enabled.join(','));
    await this.set(BACKUP_SCHEDULE_SETTING, input.schedule);
    await this.set(BACKUP_HOUR_SETTING, String(normaliseHour(input.hour ?? DEFAULT_HOUR)));
    await this.set(BACKUP_KEEP_SETTING, String(Math.max(1, Math.min(365, input.keep))));
  }

  /** Stored values for every kind, with secrets reported as present rather than returned. */
  async config(): Promise<{
    enabled: string[];
    kinds: Record<string, { values: Record<string, string>; secretsSet: Record<string, boolean> }>;
  }> {
    const kinds: Record<
      string,
      { values: Record<string, string>; secretsSet: Record<string, boolean> }
    > = {};
    for (const kind of DESTINATION_KINDS) {
      const values: Record<string, string> = {};
      const secretsSet: Record<string, boolean> = {};
      for (const field of kind.fields) {
        const value = await this.setting(backupSettingKey(kind.id, field.key));
        if (field.secret) secretsSet[field.key] = Boolean(value);
        else if (value) values[field.key] = value;
      }
      kinds[kind.id] = { values, secretsSet };
    }
    return { enabled: await this.enabledKinds(), kinds };
  }

  /*
    One-shot nonces for the Google connect flow, held in memory rather than in the
    database. They are only meaningful for the minute the user spends on Google's consent
    screen, and a CSRF nonce that outlives its round trip — or survives a restart — is a
    liability, not a feature.
  */
  private readonly oauthStates = new Map<string, number>();

  /** Where to send the browser to authorise Drive, or why we cannot. */
  async driveAuthUrl(redirectUri: string): Promise<string> {
    const clientId = await this.setting(backupSettingKey('gdrive', 'clientId'));
    const clientSecret = await this.setting(backupSettingKey('gdrive', 'clientSecret'));
    if (!clientId || !clientSecret) {
      throw new Error('Save your OAuth client ID and secret first, then connect.');
    }
    const state = randomUUID();
    const now = Date.now();
    for (const [key, born] of this.oauthStates) {
      if (now - born > OAUTH_STATE_TTL_MS) this.oauthStates.delete(key);
    }
    this.oauthStates.set(state, now);
    return driveAuthUrl(clientId, redirectUri, state);
  }

  /** Finish the connect flow: trade the code for a refresh token and store it. */
  async driveCallback(code: string, state: string, redirectUri: string): Promise<void> {
    const born = this.oauthStates.get(state);
    // Single use. A replayed callback must not be able to rewrite the stored token.
    this.oauthStates.delete(state);
    if (!born || Date.now() - born > OAUTH_STATE_TTL_MS) {
      throw new Error('That authorisation link has expired. Start again from Settings.');
    }
    const clientId = await this.setting(backupSettingKey('gdrive', 'clientId'));
    const clientSecret = await this.setting(backupSettingKey('gdrive', 'clientSecret'));
    if (!clientId || !clientSecret) throw new Error('No OAuth client saved.');
    const refreshToken = await exchangeCodeForRefreshToken(
      clientId,
      clientSecret,
      code,
      redirectUri,
    );
    await this.set(backupSettingKey('gdrive', 'refreshToken'), refreshToken);
    this.logger.log('Google Drive connected');
  }

  /** Forget the Drive authorisation without touching the OAuth client details. */
  async driveDisconnect(): Promise<void> {
    await this.set(backupSettingKey('gdrive', 'refreshToken'), '');
  }

}

/** Local-time stamp, so a filename sorts and reads the way its owner expects. */
export function stamp(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}-${get('hour') === '24' ? '00' : get('hour')}${get('minute')}`;
}
