import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

const CACHE_MS = 30_000;

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
  updatedAt: string;
}

/**
 * Reads the TeslaMate database (read-only queries) to surface vehicle state.
 * TeslaMate owns the schema; we only SELECT.
 */
@Injectable()
export class TeslamateService implements OnModuleDestroy {
  private readonly logger = new Logger(TeslamateService.name);
  private pool: Pool | null = null;
  private cached: VehicleDto | null = null;
  private cachedAt = 0;

  constructor() {
    const url = process.env.TESLAMATE_DATABASE_URL;
    if (!url) {
      this.logger.log('TESLAMATE_DATABASE_URL not set — vehicle integration disabled.');
      return;
    }
    this.pool = new Pool({ connectionString: url, max: 2 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
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

      const [position, state, charge] = await Promise.all([
        this.pool.query(
          `SELECT date, battery_level, est_battery_range_km, ideal_battery_range_km, odometer
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
      ]);

      const pos = position.rows[0];
      const lastCharge = charge.rows[0];
      const chargingNow = lastCharge && lastCharge.end_date === null;

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
