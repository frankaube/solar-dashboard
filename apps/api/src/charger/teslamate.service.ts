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
import {
  HOME_SETTING_KEYS,
  HomeLocation,
  HomeMode,
  isAtHome,
  parseHome,
  parseRadius,
  resolveMode,
} from './home-location';
import { Coordinates, SITE_SETTING_KEYS, resolveSiteLocation } from '../common/coordinates';
import { PowerSample, SolarShare, solarShareOf } from './solar-overlap';
import { chargePlace, routeLabels } from './charge-place';
import { FuelComparison, compareToGasoline, describeBasis } from './fuel-prices';
import { FuelPriceService } from './fuel-price.service';
import { localDateOf } from '../common/localdate';
import { TrackPoint, bearingFrom, boxAround, distanceKm, scaleBar, thin } from './track';
import { DrawnLine, linesIn } from '../weather/coastline';

const CACHE_MS = 30_000;

/** `timestamp without time zone`. */
const TIMESTAMP_OID = 1114;

/**
 * TeslaMate stores UTC in naked `timestamp` columns; node-postgres has no offset and would
 * otherwise build the Date in the server's local zone. Scoped to this pool rather than pg's
 * global registry, since it is wrong for a database that stores local time.
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
    /**
     * Share of this charge that came off the roof, from the car's own power samples against
     * the array's. null away from home, or before the array was reporting.
     */
    solarPct: number | null;
    solarWh: number | null;
  }>;
  /** Every charge in the window, not just the twenty listed. */
  chargeTotals: { energyWh: number; solarWh: number; solarPct: number; count: number };
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
  /**
   * What this driving would have cost in petrol, each drive at its own month's price. Null
   * when place, price series or litres-per-100km is unset — a guess would look identical.
   */
  gasComparison:
    | (FuelComparison & {
        /** The owner's assumption about the car they did not buy. */
        litresPer100Km: number;
        /** One sentence naming which distance was priced how. */
        basis: string;
      })
    | null;
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
   * Whether the car is moving, and since when. Not from `state`, which reads "online"
   * throughout a drive in progress; an unended row in `drives` knows better.
   */
  motion: {
    driving: boolean;
    speedKmh: number | null;
    /** Drive start while driving, last drive end while parked, null if it has never moved. */
    since: string | null;
  };
  /**
   * Whether the car is where home is. null — not false — when no home has been set or the
   * car has no position; those are different answers from "somewhere else".
   */
  atHome: boolean | null;
  /** Newest position sample — how current everything above is. */
  lastSeenAt: string | null;
  updatedAt: string;
}

/**
 * Is the car moving, and since when — from the newest drive row and position sample.
 * Pulled out of the query so the rule can be tested.
 */
export function deriveMotion(
  lastDrive: { start_date: Date | string; end_date: Date | string | null } | undefined,
  position: { speed: number | null } | undefined,
): VehicleDto['motion'] {
  const driving = Boolean(lastDrive && lastDrive.end_date === null);
  const since = driving ? lastDrive?.start_date : (lastDrive?.end_date ?? null);
  return {
    driving,
    // Speed is null on a parked sample, and 0 is a real reading at a red light — not the
    // same thing.
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
/** A drive drawn from bundled geography — no tile server, see track.ts. */
export interface VehicleTrackDto {
  driving: boolean;
  startedAt: string;
  endedAt: string | null;
  points: TrackPoint[];
  box: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  geography: DrawnLine[];
  home: { lat: number; lon: number } | null;
  fromHomeKm: number | null;
  bearing: string | null;
  scale: { km: number; fraction: number };
}

@Injectable()
export class TeslamateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TeslamateService.name);
  private pool: Pool | null = null;
  private cached: VehicleDto | null = null;
  private cachedAt = 0;
  /* getDetails is five SQL round trips plus a Prisma scan of the array's readings across
     the charge span, 285 ms on the Pi. Keyed by window: 7 days must not be served 30. */
  private detailCache = new Map<number, { at: number; value: VehicleDetailsDto }>();
  private current: TeslamateConfig | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fuel: FuelPriceService,
  ) {}

  /** Petrol cost of these drives, each at its own month's published price. Null when the
      geography, the series or litres-per-100km is missing. */
  private async gasComparison(
    drives: Array<{ startedAt: string; distanceKm: number }>,
  ): Promise<(FuelComparison & { litresPer100Km: number; basis: string }) | null> {
    const [series, litresRow] = await Promise.all([
      this.fuel.series(),
      this.fuel.litresPer100Km(),
    ]);
    const litresPer100Km = Number(litresRow);
    if (series.length === 0 || !Number.isFinite(litresPer100Km) || litresPer100Km <= 0) return null;

    const comparison = compareToGasoline(
      drives.map((d) => ({ startedAt: d.startedAt, distanceKm: d.distanceKm, consumptionKwh: null })),
      series,
      litresPer100Km,
      localDateOf,
    );
    return { ...comparison, litresPer100Km, basis: describeBasis(comparison) };
  }

  /**
   * Settings first, environment second. TESLAMATE_DATABASE_URL stays supported as a
   * bootstrap so an existing compose file keeps working.
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
    // Host is the one field with no sensible default, so a half-written config reads as
    // "not configured" rather than an unasked-for attempt to reach localhost.
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
      // Without this a wrong host hangs for the OS default, over two minutes on Linux.
      connectionTimeoutMillis: 5_000,
      types: UTC_TIMESTAMPS,
    });
    // A pool emits errors on idle clients; unhandled, they take the process down, so an
    // unreachable database would crash the dashboard rather than disable one panel.
    this.pool.on('error', (error) => this.logger.warn(`TeslaMate pool: ${error.message}`));
    this.current = config;
    this.cached = null;
    this.detailCache.clear();
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
   * Try a config without saving it. Returns the car it found, not just ok/not-ok: on a host
   * with two instances that is the difference between working credentials and the right one.
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

  /** For re-testing a config whose form did not resend the password. Server-side only. */
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
    this.detailCache.clear();
    this.savedInApp = false;
    this.logger.log('Vehicle integration disconnected.');
  }

  /**
   * Solar share per charging process, from the car's power samples against the array's.
   * One query for all of them rather than a round trip per charge.
   */
  private async solarShares(processIds: number[]): Promise<Map<number, SolarShare>> {
    const out = new Map<number, SolarShare>();
    if (!this.pool || processIds.length === 0) return out;

    const samples = await this.pool.query(
      `SELECT charging_process_id, date, charger_power
       FROM charges
       WHERE charging_process_id = ANY($1::int[]) AND charger_power IS NOT NULL
       ORDER BY date ASC`,
      [processIds],
    );
    if (samples.rows.length === 0) return out;

    const byProcess = new Map<number, PowerSample[]>();
    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;
    for (const row of samples.rows) {
      const t = new Date(row.date).getTime();
      earliest = Math.min(earliest, t);
      latest = Math.max(latest, t);
      const id = Number(row.charging_process_id);
      const list = byProcess.get(id) ?? [];
      // charger_power is kW in TeslaMate; everything downstream is watts.
      list.push({ t, w: Number(row.charger_power) * 1000 });
      byProcess.set(id, list);
    }

    // Only the span the charges actually cover — not the whole retention window.
    const solarRows = await this.prisma.dtuReading.findMany({
      where: { takenAt: { gte: new Date(earliest - 15 * 60_000), lte: new Date(latest + 15 * 60_000) } },
      orderBy: { takenAt: 'asc' },
      select: { takenAt: true, totalPower: true },
    });
    const solar: PowerSample[] = solarRows.map((row) => ({
      t: row.takenAt.getTime(),
      w: Number(row.totalPower),
    }));

    for (const [id, draw] of byProcess) {
      out.set(id, solarShareOf(draw, solar));
    }
    return out;
  }

  /**
   * The saved home, or null if nobody has set one. In `site` mode the coordinates are read
   * fresh each time rather than copied: two copies of a driveway drift apart invisibly.
   */
  async home(): Promise<HomeLocation | null> {
    const { home } = await this.homeState();
    return home;
  }

  /** Home plus how it was arrived at, for the settings form and for the endpoint. */
  async homeState(): Promise<{ home: HomeLocation | null; mode: HomeMode; site: Coordinates | null }> {
    const rows = await this.prisma.setting.findMany({
      where: {
        key: {
          in: [...Object.values(HOME_SETTING_KEYS), ...Object.values(SITE_SETTING_KEYS)],
        },
      },
    });
    const value = (key: string): string | undefined => rows.find((row) => row.key === key)?.value;

    const site = resolveSiteLocation(value);
    const manual = parseHome({
      latitude: value(HOME_SETTING_KEYS.latitude),
      longitude: value(HOME_SETTING_KEYS.longitude),
      radiusM: value(HOME_SETTING_KEYS.radiusM),
    }).home;
    const mode = resolveMode(value(HOME_SETTING_KEYS.mode), manual !== null);
    const { radiusM } = parseRadius(value(HOME_SETTING_KEYS.radiusM));

    if (mode === 'manual') return { home: manual, mode, site };
    // Following a site that has not been set yet is not an error, it is "home is unknown".
    return { home: site ? { ...site, radiusM } : null, mode, site };
  }

  async saveHome(home: HomeLocation): Promise<void> {
    const entries: Array<[string, string]> = [
      [HOME_SETTING_KEYS.latitude, String(home.latitude)],
      [HOME_SETTING_KEYS.longitude, String(home.longitude)],
      [HOME_SETTING_KEYS.radiusM, String(home.radiusM)],
      [HOME_SETTING_KEYS.mode, 'manual'],
    ];
    for (const [key, value] of entries) {
      await this.prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    // The vehicle payload carries atHome, so a stale cache would show the old answer for
    // half a minute after Save.
    this.cached = null;
    this.detailCache.clear();
  }

  /**
   * Follow the site instead of holding coordinates of its own. The old manual pair is
   * deleted, not kept: otherwise a cleared site reverts home to stale coordinates.
   */
  async followSite(radiusM: number): Promise<void> {
    await this.prisma.setting.deleteMany({
      where: { key: { in: [HOME_SETTING_KEYS.latitude, HOME_SETTING_KEYS.longitude] } },
    });
    for (const [key, value] of [
      [HOME_SETTING_KEYS.mode, 'site'],
      [HOME_SETTING_KEYS.radiusM, String(radiusM)],
    ] as const) {
      await this.prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    this.cached = null;
    this.detailCache.clear();
  }

  /** Forget everything about home, mode included, which lands back on following the site. */
  async clearHome(): Promise<void> {
    await this.prisma.setting.deleteMany({
      where: { key: { in: Object.values(HOME_SETTING_KEYS) } },
    });
    this.cached = null;
    this.detailCache.clear();
  }

  /** Where the car is now — for the "use the car's location" button. */
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
    const fresh = this.detailCache.get(days);
    if (fresh && Date.now() - fresh.at < CACHE_MS) return fresh.value;
    const vehicle = await this.getVehicle();
    if (!vehicle) return null;
    const car = await this.pool.query(
      'SELECT id, efficiency FROM cars ORDER BY id LIMIT 1',
    );
    const carId = car.rows[0].id as number;
    /** kWh per km of rated range — TeslaMate's factor for consumption from range deltas. */
    const efficiency = Number(car.rows[0].efficiency ?? 0.15);
    const home = await this.home();

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
                sa.name AS from_name, sa.road AS from_road, sa.city AS from_city,
                ea.name AS to_name, ea.road AS to_road, ea.city AS to_city,
                sp.latitude AS from_lat, sp.longitude AS from_lon,
                ep.latitude AS to_lat, ep.longitude AS to_lon
         FROM drives d
         LEFT JOIN addresses sa ON sa.id = d.start_address_id
         LEFT JOIN addresses ea ON ea.id = d.end_address_id
         LEFT JOIN positions sp ON sp.id = d.start_position_id
         LEFT JOIN positions ep ON ep.id = d.end_position_id
         WHERE d.car_id = $1 AND d.start_date > now() - ($2 || ' days')::interval
           AND d.distance IS NOT NULL
         ORDER BY d.start_date DESC LIMIT 20`,
        [carId, days],
      ),
      this.pool.query(
        `SELECT cp.id, cp.start_date, cp.charge_energy_added, cp.charge_energy_used, cp.duration_min,
                cp.start_battery_level, cp.end_battery_level,
                a.name AS addr_name, a.road AS addr_road, a.city AS addr_city,
                pos.latitude, pos.longitude,
                EXISTS (
                  SELECT 1 FROM charges c
                  WHERE c.charging_process_id = cp.id AND c.fast_charger_present
                  LIMIT 1
                ) AS fast
         FROM charging_processes cp
         LEFT JOIN addresses a ON a.id = cp.address_id
         LEFT JOIN positions pos ON pos.id = cp.position_id
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

    /*
      Solar share from the car's own samples rather than the Wall Connector's: better
      resolution (a hundred-odd per charge) and present on installs with no Wall Connector.
      Over every charge in the window, not just the twenty shown, or the headline share
      describes an arbitrary subset.
    */
    const allCharges = await this.pool.query(
      `SELECT cp.id, cp.charge_energy_added, pos.latitude, pos.longitude,
              EXISTS (
                SELECT 1 FROM charges c
                WHERE c.charging_process_id = cp.id AND c.fast_charger_present
                LIMIT 1
              ) AS fast
       FROM charging_processes cp
       LEFT JOIN positions pos ON pos.id = cp.position_id
       WHERE cp.car_id = $1 AND cp.start_date > now() - ($2 || ' days')::interval`,
      [carId, days],
    );

    /*
      Only charges that could have come off this roof.

      The overlap maths knows nothing about where the car was, so a Supercharger stop a
      hundred kilometres away would score solar because it was sunny at the house. A DC fast
      charge is never on your own roof, and once home is configured neither is anything
      outside it; with no home set only the fast-charge rule applies.
    */
    const eligible = allCharges.rows.filter(
      (row) =>
        !row.fast &&
        isAtHome(
          row.latitude !== null && row.longitude !== null
            ? { latitude: Number(row.latitude), longitude: Number(row.longitude) }
            : null,
          home,
        ) !== false,
    );
    const solarByProcess = await this.solarShares(eligible.map((row) => Number(row.id)));

    // Totals over home charging only — which is what the card claims to describe.
    let totalEnergyWh = 0;
    let totalSolarWh = 0;
    for (const row of eligible) {
      totalEnergyWh += Number(row.charge_energy_added ?? 0) * 1000;
      totalSolarWh += solarByProcess.get(Number(row.id))?.solarWh ?? 0;
    }

    const driveRows = drives.rows.map((row) => {
      const rangeDelta =
        row.start_rated_range_km !== null && row.end_rated_range_km !== null
          ? Number(row.start_rated_range_km) - Number(row.end_rated_range_km)
          : null;
      return {
        startedAt: new Date(row.start_date).toISOString(),
        // Same treatment as charges: "Home" when it was, address parts deduped because
        // TeslaMate fills name and road with the same street.
        ...routeLabels(
          {
            place: chargePlace(
              row.from_lat !== null && row.from_lon !== null
                ? { latitude: Number(row.from_lat), longitude: Number(row.from_lon) }
                : null,
              home,
              { name: row.from_name, road: row.from_road, city: row.from_city },
            ),
            city: row.from_city,
          },
          {
            place: chargePlace(
              row.to_lat !== null && row.to_lon !== null
                ? { latitude: Number(row.to_lat), longitude: Number(row.to_lon) }
                : null,
              home,
              { name: row.to_name, road: row.to_road, city: row.to_city },
            ),
            city: row.to_city,
          },
        ),
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

    const details: VehicleDetailsDto = {
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
      charges: charges.rows.map((row) => {
        const share = solarByProcess.get(Number(row.id)) ?? null;
        return {
          startedAt: new Date(row.start_date).toISOString(),
          // "Home" beats the street address once the app knows where home is.
          location: chargePlace(
            row.latitude !== null && row.longitude !== null
              ? { latitude: Number(row.latitude), longitude: Number(row.longitude) }
              : null,
            home,
            { name: row.addr_name, road: row.addr_road, city: row.addr_city },
          ),
          energyAddedKwh: Number(row.charge_energy_added ?? 0),
          energyUsedKwh: row.charge_energy_used !== null ? Number(row.charge_energy_used) : null,
          durationMin: row.duration_min !== null ? Number(row.duration_min) : null,
          startLevel: row.start_battery_level,
          endLevel: row.end_battery_level,
          fast: Boolean(row.fast),
          solarPct: share?.solarPct ?? null,
          solarWh: share?.solarWh ?? null,
        };
      }),
      chargeTotals: {
        energyWh: Math.round(totalEnergyWh),
        solarWh: Math.round(totalSolarWh),
        solarPct: totalEnergyWh > 0 ? Math.round((totalSolarWh / totalEnergyWh) * 100) : 0,
        count: eligible.length,
      },
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
      // Priced from the drive rows themselves, not from the period total, so a January
      // drive meets January's price rather than today's.
      gasComparison: await this.gasComparison(driveRows),
      lastChargeCurve: curve.rows.map((row) => ({
        t: new Date(row.date).toISOString(),
        powerKw: Number(row.charger_power ?? 0),
        level: Number(row.battery_level ?? 0),
      })),
    };
    this.detailCache.set(days, { at: Date.now(), value: details });
    return details;
  }

  /**
   * The current drive's track, with enough local geography to place it. Nothing is fetched
   * at runtime — shorelines and borders come from the bundled Natural Earth data, see
   * track.ts. Returns the LAST drive when the car is parked; the card says which it shows.
   */
  async getTrack(): Promise<VehicleTrackDto | null> {
    if (!this.pool) return null;
    try {
      const car = await this.pool.query('SELECT id FROM cars ORDER BY id LIMIT 1');
      const carId = car.rows[0]?.id;
      if (!carId) return null;

      const drive = await this.pool.query(
        'SELECT id, start_date, end_date FROM drives WHERE car_id = $1 ORDER BY start_date DESC LIMIT 1',
        [carId],
      );
      const row = drive.rows[0];
      if (!row) return null;

      const positions = await this.pool.query(
        `SELECT date, latitude, longitude, speed
         FROM positions
         WHERE drive_id = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL
         ORDER BY date ASC`,
        [row.id],
      );

      const points: TrackPoint[] = positions.rows.map((r: Record<string, unknown>) => ({
        at: new Date(r.date as string).getTime(),
        lat: Number(r.latitude),
        lon: Number(r.longitude),
        speedKmh: r.speed === null || r.speed === undefined ? null : Number(r.speed),
      }));
      if (!points.length) return null;

      const home = await this.home();
      // Home joins the points that set the window, so a car three streets away is drawn
      // with the house in frame rather than alone at maximum zoom.
      const framing = home ? [...points, { lat: home.latitude, lon: home.longitude }] : points;
      const box = boxAround(framing);
      if (!box) return null;

      const last = points[points.length - 1];
      return {
        driving: !row.end_date,
        startedAt: new Date(row.start_date).toISOString(),
        endedAt: row.end_date ? new Date(row.end_date).toISOString() : null,
        points: thin(points),
        box,
        // Bundled vectors, not tiles. Empty inland, which the card says rather than hides.
        geography: linesIn(box),
        home: home ? { lat: home.latitude, lon: home.longitude } : null,
        fromHomeKm: home
          ? Math.round(distanceKm({ lat: home.latitude, lon: home.longitude }, last) * 10) / 10
          : null,
        bearing: home ? bearingFrom({ lat: home.latitude, lon: home.longitude }, last) : null,
        scale: scaleBar(box),
      };
    } catch (error) {
      this.logger.warn(`TeslaMate track query failed: ${(error as Error).message}`);
      return null;
    }
  }

}

/** Turn a driver error into something that says what to do; each case has a different fix. */
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
