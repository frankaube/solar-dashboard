import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, types as pgTypes } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  TESLAMATE_SETTING_KEYS,
  TeslamateConfig,
  fromConnectionString,
  normalise,
  redact,
  toConnectionString,
} from './teslamate-config';
import { HOME_SETTING_KEYS, HomeLocation, isAtHome, parseHome } from './home-location';

const CACHE_MS = 30_000;

/** `timestamp without time zone`. */
const TIMESTAMP_OID = 1114;

/**
 * TeslaMate stores UTC in naked `timestamp` columns, so read them back as UTC.
 *
 * node-postgres has no offset to work from and builds the Date in the server's local zone.
 * On a machine set to America/Halifax that put every vehicle timestamp three hours into
 * the future — a drive that ended at 18:51 was served as 21:51Z, and "parked since" came
 * out as a moment that had not happened yet. Every drive, charge, software update and
 * battery sample the app has ever shown carried the same skew; it went unnoticed because
 * a chart of the last seven days looks equally plausible shifted by three hours.
 *
 * Scoped to this pool rather than pg's global registry: this parser is right for
 * TeslaMate's convention and would be wrong for a database that stores local time.
 */
const UTC_TIMESTAMPS = {
  getTypeParser: ((oid: number, format?: unknown) =>
    oid === TIMESTAMP_OID
      ? (value: string | null) => (value === null ? null : new Date(`${value.replace(' ', 'T')}Z`))
      : pgTypes.getTypeParser(oid, format as never)) as typeof pgTypes.getTypeParser,
};

export interface VehicleDetailsDto {
  vehicle: VehicleDto | null;
  battery: Array<{ t: string; level: number }>;
  drives: Array<{
    startedAt: string;
    from: string | null;
    to: string | null;
    distanceKm: number;
    durationMin: number;
    consumptionKwh: number | null;
    outsideTempC: number | null;
    speedMaxKmh: number | null;
  }>;
  charges: Array<{
    startedAt: string;
    location: string | null;
    energyAddedKwh: number;
    energyUsedKwh: number | null;
    durationMin: number | null;
    startLevel: number | null;
    endLevel: number | null;
    fast: boolean;
  }>;
  updates: Array<{ installedAt: string; version: string }>;
  phantomDrain: {
    avgPctPerDay: number | null;
    worstGap: { start: string; end: string; pct: number } | null;
  };
  stats: {
    days: number;
    drivenKm: number;
    driveCount: number;
    energyUsedKwh: number;
    energyAddedKwh: number;
    avgConsumptionWhKm: number | null;
  };
  lastChargeCurve: Array<{ t: string; powerKw: number; level: number }>;
}

export interface VehicleDto {
  name: string;
  model: string;
  state: string;
  batteryLevel: number | null;
  rangeKm: number | null;
  odometerKm: number | null;
  charging: { startedAt: string; energyAddedKwh: number } | null;
  /**
   * Whether the car is moving, and since when.
   *
   * Deliberately not derived from `state`: TeslaMate reported "online" throughout a drive
   * that was demonstrably in progress — an open row in `drives` and position samples at
   * 47 km/h. An unended drive is the car asserting something about itself; `state` only
   * says the API is answering.
   */
  motion: {
    driving: boolean;
    speedKmh: number | null;
    /** Drive start while driving, last drive end while parked, null if it has never moved. */
    since: string | null;
  };
  /**
   * Whether the car is where home is.
   *
   * null when no home has been set or the car has no position — not false. A screen has to
   * be able to tell "nobody has said where home is" from "the car is somewhere else".
   */
  atHome: boolean | null;
  /** Newest position sample — how current everything above is. */
  lastSeenAt: string | null;
  updatedAt: string;
}

/**
 * Is the car moving, and since when — from the newest drive row and position sample.
 *
 * Pulled out of the query so the rule can be tested: the whole point of it is that
 * `states.state` said "online" for the duration of a drive at 47 km/h, and the thing that
 * knew better was an unended row in `drives`.
 */
export function deriveMotion(
  lastDrive: { start_date: Date | string; end_date: Date | string | null } | undefined,
  position: { speed: number | null } | undefined,
): VehicleDto['motion'] {
  const driving = Boolean(lastDrive && lastDrive.end_date === null);
  const since = driving ? lastDrive?.start_date : (lastDrive?.end_date ?? null);
  return {
    driving,
    // Speed is null on a parked sample, and 0 is a real reading at a red light — keep
    // them apart rather than collapsing both into "not moving".
    speedKmh:
      driving && position?.speed !== null && position?.speed !== undefined
        ? Math.round(Number(position.speed))
        : null,
    since: since ? new Date(since).toISOString() : null,
  };
}

/**
 * Reads the TeslaMate database (read-only queries) to surface vehicle state.
 * TeslaMate owns the schema; we only SELECT.
 */
@Injectable()
export class TeslamateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TeslamateService.name);
  private pool: Pool | null = null;
  private cached: VehicleDto | null = null;
  private cachedAt = 0;
  private current: TeslamateConfig | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Settings first, environment second.
   *
   * The environment used to be the only way in, which made adding a car to a running
   * install an ssh session and a restart. It stays supported as a bootstrap — a compose
   * file setting TESLAMATE_DATABASE_URL should still work untouched — but anything saved
   * in the app wins, because that is the thing a person just chose on purpose.
   */
  async onModuleInit(): Promise<void> {
    const stored = await this.storedConfig();
    if (stored) {
      this.connect(stored);
      return;
    }
    const url = process.env.TESLAMATE_DATABASE_URL;
    if (!url) {
      this.logger.log('No TeslaMate database configured — vehicle integration off.');
      return;
    }
    const parsed = fromConnectionString(url);
    if (!parsed) {
      this.logger.warn('TESLAMATE_DATABASE_URL is not a valid postgres URL — ignoring it.');
      return;
    }
    this.connect(parsed);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private async storedConfig(): Promise<TeslamateConfig | null> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: Object.values(TESLAMATE_SETTING_KEYS) } },
    });
    if (rows.length === 0) return null;
    const value = (key: string): string | undefined =>
      rows.find((row) => row.key === key)?.value;
    const host = value(TESLAMATE_SETTING_KEYS.host);
    // Host is the one field with no sensible default: without it there is nothing to
    // connect to, and a half-written config should read as "not configured" rather than
    // as an attempt to reach localhost that nobody asked for.
    if (!host) return null;
    return normalise({
      host,
      port: Number(value(TESLAMATE_SETTING_KEYS.port)),
      user: value(TESLAMATE_SETTING_KEYS.user),
      password: value(TESLAMATE_SETTING_KEYS.password),
      database: value(TESLAMATE_SETTING_KEYS.database),
    });
  }

  private connect(config: TeslamateConfig): void {
    this.pool = new Pool({
      connectionString: toConnectionString(config),
      max: 2,
      // Without this a wrong host hangs the request that triggered it for the OS default,
      // which on Linux is over two minutes. A Test button that appears to do nothing for
      // two minutes is worse than one that fails.
      connectionTimeoutMillis: 5_000,
      types: UTC_TIMESTAMPS,
    });
    // A pool emits errors on idle clients; unhandled, they take the process down — so an
    // unreachable database would crash the whole dashboard rather than disable one panel.
    this.pool.on('error', (error) => this.logger.warn(`TeslaMate pool: ${error.message}`));
    this.current = config;
    this.cached = null;
    this.cachedAt = 0;
    this.logger.log(`Vehicle data from ${redact(config)}`);
  }

  /** What is configured, for the settings panel. Never includes the password. */
  describe(): { configured: boolean; describe: string | null; fromEnvironment: boolean } {
    return {
      configured: this.pool !== null,
      describe: this.current ? redact(this.current) : null,
      fromEnvironment: this.pool !== null && this.current !== null && !this.savedInApp,
    };
  }

  private savedInApp = false;

  /** Current field values for the form. Password is returned as a flag, never a value. */
  async config(): Promise<{ config: Omit<TeslamateConfig, 'password'>; passwordSet: boolean } | null> {
    if (!this.current) return null;
    const { password, ...rest } = this.current;
    return { config: rest, passwordSet: password.length > 0 };
  }

  /**
   * Try a config without saving it.
   *
   * Returns what it found rather than just ok/not-ok: naming the car is the difference
   * between "the credentials work" and "this is the right database". Someone with two
   * TeslaMate instances would otherwise have no way to tell them apart from here.
   */
  async test(config: TeslamateConfig): Promise<{ ok: boolean; message: string; car?: string }> {
    const pool = new Pool({
      connectionString: toConnectionString(config),
      max: 1,
      connectionTimeoutMillis: 5_000,
      types: UTC_TIMESTAMPS,
    });
    pool.on('error', () => undefined);
    try {
      const result = await pool.query(
        'SELECT name, model, marketing_name FROM cars ORDER BY id LIMIT 1',
      );
      if (result.rows.length === 0) {
        return {
          ok: true,
          message: 'Connected, but this database has no cars in it yet. TeslaMate adds one once it has signed in to your Tesla account.',
        };
      }
      const row = result.rows[0] as { name: string | null; model: string; marketing_name: string | null };
      const car = `${row.name ?? 'Tesla'} — Model ${row.model}${row.marketing_name ? ` ${row.marketing_name}` : ''}`;
      return { ok: true, message: `Connected. Found ${car}.`, car };
    } catch (error) {
      return { ok: false, message: explain(error as NodeJS.ErrnoException) };
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  /** Save and reconnect, with no restart. */
  async save(config: TeslamateConfig): Promise<void> {
    const entries: Array<[string, string]> = [
      [TESLAMATE_SETTING_KEYS.host, config.host],
      [TESLAMATE_SETTING_KEYS.port, String(config.port)],
      [TESLAMATE_SETTING_KEYS.user, config.user],
      [TESLAMATE_SETTING_KEYS.password, config.password],
      [TESLAMATE_SETTING_KEYS.database, config.database],
    ];
    for (const [key, value] of entries) {
      await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
    await this.pool?.end().catch(() => undefined);
    this.pool = null;
    this.connect(config);
    this.savedInApp = true;
  }

  /**
   * The saved password, for the one caller that legitimately needs it: re-testing a config
   * whose form did not resend it. Never leaves the server by any other route.
   */
  async storedPassword(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({
      where: { key: TESLAMATE_SETTING_KEYS.password },
    });
    return row?.value ?? this.current?.password ?? null;
  }

  /** Forget it entirely, so the panel goes back to offering a fresh connection. */
  async disconnect(): Promise<void> {
    await this.prisma.setting.deleteMany({
      where: { key: { in: Object.values(TESLAMATE_SETTING_KEYS) } },
    });
    await this.pool?.end().catch(() => undefined);
    this.pool = null;
    this.current = null;
    this.cached = null;
    this.savedInApp = false;
    this.logger.log('Vehicle integration disconnected.');
  }

  /** The saved home, or null if nobody has set one. */
  async home(): Promise<HomeLocation | null> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: Object.values(HOME_SETTING_KEYS) } },
    });
    if (rows.length === 0) return null;
    const value = (key: string): string | undefined => rows.find((row) => row.key === key)?.value;
    // Through the same parser the form goes through: a half-written or hand-edited row
    // should read as "no home" rather than as a circle somewhere in the Atlantic.
    return parseHome({
      latitude: value(HOME_SETTING_KEYS.latitude),
      longitude: value(HOME_SETTING_KEYS.longitude),
      radiusM: value(HOME_SETTING_KEYS.radiusM),
    }).home;
  }

  async saveHome(home: HomeLocation): Promise<void> {
    const entries: Array<[string, string]> = [
      [HOME_SETTING_KEYS.latitude, String(home.latitude)],
      [HOME_SETTING_KEYS.longitude, String(home.longitude)],
      [HOME_SETTING_KEYS.radiusM, String(home.radiusM)],
    ];
    for (const [key, value] of entries) {
      await this.prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    // The vehicle payload carries atHome, so a stale cache would show the old answer for
    // half a minute after someone just pressed Save and is watching for it to change.
    this.cached = null;
  }

  async clearHome(): Promise<void> {
    await this.prisma.setting.deleteMany({
      where: { key: { in: Object.values(HOME_SETTING_KEYS) } },
    });
    this.cached = null;
  }

  /**
   * Where the car is now — for the "use the car's location" button.
   *
   * Setting home by typing coordinates means leaving the app to find them. The car is
   * usually sitting in the driveway while someone is configuring this, and it already
   * knows exactly where that is.
   */
  async currentPosition(): Promise<{ latitude: number; longitude: number; at: string } | null> {
    if (!this.pool) return null;
    try {
      const result = await this.pool.query(
        `SELECT date, latitude, longitude FROM positions
         WHERE car_id = (SELECT id FROM cars ORDER BY id LIMIT 1)
           AND latitude IS NOT NULL AND longitude IS NOT NULL
         ORDER BY date DESC LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        at: new Date(row.date).toISOString(),
      };
    } catch (error) {
      this.logger.warn(`TeslaMate position read failed: ${(error as Error).message}`);
      return null;
    }
  }

  async getVehicle(): Promise<VehicleDto | null> {
    if (!this.pool) return null;
    if (this.cached && Date.now() - this.cachedAt < CACHE_MS) return this.cached;
    try {
      const car = await this.pool.query(
        'SELECT id, name, model, marketing_name FROM cars ORDER BY id LIMIT 1',
      );
      if (!car.rows.length) return null;
      const carId = car.rows[0].id as number;

      const [position, state, charge, drive] = await Promise.all([
        this.pool.query(
          `SELECT date, battery_level, est_battery_range_km, ideal_battery_range_km, odometer,
                  speed, latitude, longitude
           FROM positions WHERE car_id = $1 ORDER BY date DESC LIMIT 1`,
          [carId],
        ),
        this.pool.query(
          'SELECT state FROM states WHERE car_id = $1 ORDER BY start_date DESC LIMIT 1',
          [carId],
        ),
        this.pool.query(
          `SELECT start_date, end_date, charge_energy_added
           FROM charging_processes WHERE car_id = $1 ORDER BY start_date DESC LIMIT 1`,
          [carId],
        ),
        // One row answers both cases: unended means driving, ended means parked since then.
        this.pool.query(
          'SELECT start_date, end_date FROM drives WHERE car_id = $1 ORDER BY start_date DESC LIMIT 1',
          [carId],
        ),
      ]);

      const pos = position.rows[0];
      const lastCharge = charge.rows[0];
      const chargingNow = lastCharge && lastCharge.end_date === null;
      const motion = deriveMotion(drive.rows[0], pos);
      const home = await this.home();

      this.cached = {
        name: car.rows[0].name ?? 'Tesla',
        model: `Model ${car.rows[0].model}${car.rows[0].marketing_name ? ` ${car.rows[0].marketing_name}` : ''}`,
        state: state.rows[0]?.state ?? 'unknown',
        batteryLevel: pos?.battery_level ?? null,
        rangeKm:
          pos?.est_battery_range_km !== null && pos?.est_battery_range_km !== undefined
            ? Math.round(Number(pos.est_battery_range_km))
            : pos?.ideal_battery_range_km
              ? Math.round(Number(pos.ideal_battery_range_km))
              : null,
        odometerKm: pos?.odometer ? Math.round(Number(pos.odometer)) : null,
        motion,
        atHome: isAtHome(
          pos ? { latitude: Number(pos.latitude), longitude: Number(pos.longitude) } : null,
          home,
        ),
        lastSeenAt: pos?.date ? new Date(pos.date).toISOString() : null,
        charging: chargingNow
          ? {
              startedAt: new Date(lastCharge.start_date).toISOString(),
              energyAddedKwh: Number(lastCharge.charge_energy_added ?? 0),
            }
          : null,
        updatedAt: pos?.date ? new Date(pos.date).toISOString() : new Date().toISOString(),
      };
      this.cachedAt = Date.now();
      return this.cached;
    } catch (error) {
      this.logger.warn(`TeslaMate query failed: ${(error as Error).message}`);
      return this.cached;
    }
  }

  async getDetails(days: number): Promise<VehicleDetailsDto | null> {
    if (!this.pool) return null;
    const vehicle = await this.getVehicle();
    if (!vehicle) return null;
    const car = await this.pool.query(
      'SELECT id, efficiency FROM cars ORDER BY id LIMIT 1',
    );
    const carId = car.rows[0].id as number;
    /** kWh per km of rated range — TeslaMate's factor for consumption from range deltas. */
    const efficiency = Number(car.rows[0].efficiency ?? 0.15);
    const shortAddress = `trim(BOTH ', ' FROM concat_ws(', ', NULLIF(a.name, ''), a.road, a.city))`;

    const [battery, drives, charges, updates, curve] = await Promise.all([
      this.pool.query(
        `SELECT date_trunc('hour', date) AS t, round(avg(battery_level)) AS level
         FROM positions
         WHERE car_id = $1 AND date > now() - interval '7 days' AND battery_level IS NOT NULL
         GROUP BY 1 ORDER BY 1`,
        [carId],
      ),
      this.pool.query(
        `SELECT d.start_date, d.distance, d.duration_min, d.outside_temp_avg, d.speed_max,
                d.start_rated_range_km, d.end_rated_range_km,
                ${shortAddress.replace(/a\./g, 'sa.')} AS from_addr,
                ${shortAddress.replace(/a\./g, 'ea.')} AS to_addr
         FROM drives d
         LEFT JOIN addresses sa ON sa.id = d.start_address_id
         LEFT JOIN addresses ea ON ea.id = d.end_address_id
         WHERE d.car_id = $1 AND d.start_date > now() - ($2 || ' days')::interval
           AND d.distance IS NOT NULL
         ORDER BY d.start_date DESC LIMIT 20`,
        [carId, days],
      ),
      this.pool.query(
        `SELECT cp.start_date, cp.charge_energy_added, cp.charge_energy_used, cp.duration_min,
                cp.start_battery_level, cp.end_battery_level,
                ${shortAddress} AS location,
                EXISTS (
                  SELECT 1 FROM charges c
                  WHERE c.charging_process_id = cp.id AND c.fast_charger_present
                  LIMIT 1
                ) AS fast
         FROM charging_processes cp
         LEFT JOIN addresses a ON a.id = cp.address_id
         WHERE cp.car_id = $1 AND cp.start_date > now() - ($2 || ' days')::interval
         ORDER BY cp.start_date DESC LIMIT 20`,
        [carId, days],
      ),
      this.pool.query(
        `SELECT start_date, version FROM updates
         WHERE car_id = $1 AND version IS NOT NULL
         ORDER BY start_date DESC LIMIT 5`,
        [carId],
      ),
      this.pool.query(
        `SELECT c.date, c.charger_power, c.battery_level
         FROM charges c
         WHERE c.charging_process_id = (
           SELECT id FROM charging_processes WHERE car_id = $1 ORDER BY start_date DESC LIMIT 1
         )
         ORDER BY c.date`,
        [carId],
      ),
    ]);

    const driveRows = drives.rows.map((row) => {
      const rangeDelta =
        row.start_rated_range_km !== null && row.end_rated_range_km !== null
          ? Number(row.start_rated_range_km) - Number(row.end_rated_range_km)
          : null;
      return {
        startedAt: new Date(row.start_date).toISOString(),
        from: row.from_addr || null,
        to: row.to_addr || null,
        distanceKm: Number(row.distance),
        durationMin: Number(row.duration_min ?? 0),
        consumptionKwh: rangeDelta !== null ? Number((rangeDelta * efficiency).toFixed(2)) : null,
        outsideTempC: row.outside_temp_avg !== null ? Number(row.outside_temp_avg) : null,
        speedMaxKmh: row.speed_max !== null ? Number(row.speed_max) : null,
      };
    });

    const drivenKm = driveRows.reduce((a, d) => a + d.distanceKm, 0);
    const energyUsedKwh = driveRows.reduce((a, d) => a + (d.consumptionKwh ?? 0), 0);
    const energyAddedKwh = charges.rows.reduce(
      (a, row) => a + Number(row.charge_energy_added ?? 0),
      0,
    );

    const batterySeries = battery.rows.map((row) => ({
      t: new Date(row.t).getTime(),
      level: Number(row.level),
    }));
    const levelNear = (t: number): number | null => {
      let best: { dt: number; level: number } | null = null;
      for (const sample of batterySeries) {
        const dt = Math.abs(sample.t - t);
        if (dt <= 2 * 60 * 60_000 && (best === null || dt < best.dt)) {
          best = { dt, level: sample.level };
        }
      }
      return best?.level ?? null;
    };
    // Parked gaps: time between consecutive activity intervals (drives + charges) > 4h.
    const activity = [
      ...drives.rows.map((row) => ({
        start: new Date(row.start_date).getTime(),
        end: new Date(row.start_date).getTime() + Number(row.duration_min ?? 0) * 60_000,
      })),
      ...charges.rows.map((row) => ({
        start: new Date(row.start_date).getTime(),
        end: new Date(row.start_date).getTime() + Number(row.duration_min ?? 0) * 60_000,
      })),
    ].sort((a, b) => a.start - b.start);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
    const boundaries = [
      weekAgo,
      ...activity.filter((a) => a.end > weekAgo).flatMap((a) => [a.start, a.end]),
      Date.now(),
    ];
    const drains: Array<{ start: number; end: number; pct: number }> = [];
    for (let i = 0; i + 1 < boundaries.length; i += 2) {
      const gapStart = boundaries[i + 1] ?? boundaries[i];
      const gapEnd = boundaries[i + 2] ?? Date.now();
      if (gapEnd - gapStart < 4 * 60 * 60_000) continue;
      const a = levelNear(gapStart);
      const b = levelNear(gapEnd);
      if (a !== null && b !== null && a > b) {
        drains.push({ start: gapStart, end: gapEnd, pct: a - b });
      }
    }
    const totalDrainPct = drains.reduce((acc, d) => acc + d.pct, 0);
    const totalDrainHours = drains.reduce((acc, d) => acc + (d.end - d.start) / 3_600_000, 0);
    const worst = drains.reduce(
      (w, d) => (w === null || d.pct > w.pct ? d : w),
      null as { start: number; end: number; pct: number } | null,
    );

    return {
      vehicle,
      battery: batterySeries.map((sample) => ({
        t: new Date(sample.t).toISOString(),
        level: sample.level,
      })),
      phantomDrain: {
        avgPctPerDay:
          totalDrainHours > 0 ? Number(((totalDrainPct / totalDrainHours) * 24).toFixed(1)) : null,
        worstGap: worst
          ? {
              start: new Date(worst.start).toISOString(),
              end: new Date(worst.end).toISOString(),
              pct: worst.pct,
            }
          : null,
      },
      drives: driveRows,
      charges: charges.rows.map((row) => ({
        startedAt: new Date(row.start_date).toISOString(),
        location: row.location || null,
        energyAddedKwh: Number(row.charge_energy_added ?? 0),
        energyUsedKwh: row.charge_energy_used !== null ? Number(row.charge_energy_used) : null,
        durationMin: row.duration_min !== null ? Number(row.duration_min) : null,
        startLevel: row.start_battery_level,
        endLevel: row.end_battery_level,
        fast: Boolean(row.fast),
      })),
      updates: updates.rows.map((row) => ({
        installedAt: new Date(row.start_date).toISOString(),
        version: String(row.version),
      })),
      stats: {
        days,
        drivenKm: Math.round(drivenKm),
        driveCount: driveRows.length,
        energyUsedKwh: Number(energyUsedKwh.toFixed(1)),
        energyAddedKwh: Number(energyAddedKwh.toFixed(1)),
        avgConsumptionWhKm:
          drivenKm > 0 ? Math.round((energyUsedKwh * 1000) / drivenKm) : null,
      },
      lastChargeCurve: curve.rows.map((row) => ({
        t: new Date(row.date).toISOString(),
        powerKw: Number(row.charger_power ?? 0),
        level: Number(row.battery_level ?? 0),
      })),
    };
  }
}

/**
 * Turn a driver error into something that says what to do.
 *
 * "connect ECONNREFUSED 127.0.0.1:5432" is accurate and useless. Each of these has a
 * different fix, and the difference between them is the whole value of a Test button.
 */
function explain(error: NodeJS.ErrnoException): string {
  const message = error.message ?? String(error);
  if (error.code === 'ECONNREFUSED') {
    return 'Nothing is listening there. Check TeslaMate is running, and that its Postgres port is published to this machine.';
  }
  if (error.code === 'ETIMEDOUT' || /timeout/i.test(message)) {
    return 'No answer before the timeout. Usually the wrong host, or a firewall between here and there.';
  }
  if (error.code === 'ENOTFOUND') {
    return 'That hostname does not resolve. Try the IP address instead.';
  }
  if (/password authentication failed/i.test(message)) {
    return 'The database rejected that user or password.';
  }
  if (/database .* does not exist/i.test(message)) {
    return 'Connected, but there is no database by that name on that server.';
  }
  if (/relation "cars" does not exist/i.test(message)) {
    return 'Connected, but this does not look like a TeslaMate database — it has no cars table.';
  }
  return message;
}
