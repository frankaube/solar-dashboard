import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SITE_TIMEZONE } from '../common/localdate';
import { HOUR_MS, RawSample, bucketByHour, reconcile } from './rollup';

/**
 * Folding the five-minute record into hours: ~9,870 panel readings a day become 1,008.
 *
 * THIS SERVICE DELETES NOTHING. Raw rows and hourly summaries run side by side, checked
 * nightly against each other; the rollup makes a purge possible later, it is not the purge.
 *
 * WORK IS BATCHED BY LOCAL DAY. `localDate` is indexed on DtuReading, bounds how much is
 * held at once, and is a natural interruption point. It also makes the job self-healing: a
 * day is rolled whenever its hourly rows do not account for its raw ones, so a gap filled
 * from a vendor export weeks later is picked up on the next run.
 */

/** After the nightly backup, so a fresh snapshot always predates any change. */
const RUN_HOUR = 4;
const CHECK_INTERVAL_MS = 30 * 60_000;
/** Days per pass, so a first run over a long history does not hold the database for an hour. */
const MAX_DAYS_PER_RUN = 40;

@Injectable()
export class RollupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RollupService.name);
  private timer: NodeJS.Timeout | null = null;
  private lastRunDate: string | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /*
    Once a day, checked twice an hour — same shape as the backup scheduler, so a reboot or
    redeploy cannot silently end the schedule.
  */
  private async tick(): Promise<void> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (this.lastRunDate === today || now.getHours() < RUN_HOUR || this.running) return;
    this.lastRunDate = today;
    await this.run(now);
  }

  async run(now: Date = new Date()): Promise<{ days: number; disagreements: number }> {
    if (this.running) return { days: 0, disagreements: 0 };
    this.running = true;
    try {
      const days = (await this.daysNeedingWork(now)).slice(0, MAX_DAYS_PER_RUN);
      for (const localDate of days) await this.rollDay(localDate);
      const disagreements = await this.verify();
      if (days.length > 0) this.logger.log(`Rollup: folded ${days.length} day(s) to hours`);
      if (disagreements > 0) {
        // Loud: this is the signal that must be trusted before anything is ever deleted.
        this.logger.warn(
          `Rollup: ${disagreements} day(s) where the hourly totals do not match the raw ` +
            'readings. Raw data is untouched; this is exactly the check that must be clean ' +
            'before any purge is considered.',
        );
      }
      return { days: days.length, disagreements };
    } catch (error) {
      this.logger.warn(`Rollup failed: ${(error as Error).message}`);
      return { days: 0, disagreements: 0 };
    } finally {
      this.running = false;
    }
  }

  /** Days whose hourly rows do not account for every raw reading they were built from. */
  private async daysNeedingWork(now: Date): Promise<string[]> {
    // Today is still being written to; rolling a partial day only has to be redone tomorrow.
    const today = now.toISOString().slice(0, 10);
    const [rawDtu, rolledDtu, rolledPortDays] = await Promise.all([
      this.prisma.dtuReading.groupBy({ by: ['localDate'], _count: { _all: true } }),
      this.prisma.dtuHourly.groupBy({ by: ['localDate'], _sum: { samples: true } }),
      this.prisma.portHourly.groupBy({ by: ['localDate'], _count: { _all: true } }),
    ]);
    const haveDtu = new Map(rolledDtu.map((row) => [row.localDate, row._sum.samples ?? 0]));
    const havePorts = new Set(rolledPortDays.map((row) => row.localDate));

    const pending: string[] = [];
    for (const row of rawDtu) {
      if (row.localDate >= today) continue;
      const short = (haveDtu.get(row.localDate) ?? 0) < row._count._all;
      /*
        PortReading carries no localDate of its own, so the gateway's day list drives both
        tables. A day with no port rollup is unfinished even where the gateway side looks
        complete.
      */
      if (short || !havePorts.has(row.localDate)) pending.push(row.localDate);
    }
    return pending.sort();
  }

  /** One local day of both tables, folded and written. Safe to repeat: every write upserts. */
  private async rollDay(localDate: string): Promise<void> {
    const dtuRows = await this.prisma.dtuReading.findMany({
      where: { localDate },
      orderBy: { takenAt: 'asc' },
      select: { dtuId: true, takenAt: true, totalPower: true, dailyEnergy: true, source: true },
    });
    if (dtuRows.length === 0) return;

    for (const [dtuId, rows] of groupBy(dtuRows, (row) => row.dtuId)) {
      const samples: RawSample[] = rows.map((row) => ({
        takenAt: row.takenAt,
        powerW: row.totalPower,
        counter: row.dailyEnergy,
        imported: row.source !== 'dtu',
      }));
      /*
        The day starts from zero, not from the first reading. `dailyEnergy` resets at
        midnight, so measuring the first hour from its own first sample discards everything
        produced between the reset and that sample — 4 to 160 Wh a day on real history,
        always short. From zero, the day's hours sum to the counter's final value.
      */
      for (const hour of bucketByHour(samples, SITE_TIMEZONE, 0)) {
        const data = {
          localDate: hour.localDate,
          avgPowerW: hour.avgPowerW,
          maxPowerW: hour.maxPowerW,
          energyWh: hour.energyWh,
          lastDailyEnergy: Math.round(hour.lastCounter),
          samples: hour.samples,
          imported: hour.imported,
        };
        await this.prisma.dtuHourly.upsert({
          where: { dtuId_hourStart: { dtuId, hourStart: hour.hourStart } },
          create: { dtuId, hourStart: hour.hourStart, ...data },
          update: data,
        });
      }
    }

    /*
      The port window comes from the gateway's own rows for that day, not from midnight
      arithmetic: ports are read in the same poll cycle, so they fall inside it, and taking
      the bounds from data avoids a second implementation of "which day is this".
    */
    const from = new Date(dtuRows[0].takenAt.getTime() - HOUR_MS);
    const to = new Date(dtuRows[dtuRows.length - 1].takenAt.getTime() + HOUR_MS);
    const portRows = await this.prisma.portReading.findMany({
      where: { takenAt: { gte: from, lte: to } },
      orderBy: { takenAt: 'asc' },
      select: { pvPortId: true, takenAt: true, power: true, energyDaily: true, energyTotal: true },
    });

    for (const [pvPortId, rows] of groupBy(portRows, (row) => row.pvPortId)) {
      /*
        `energyDaily` is the counter, NOT `energyTotal`. The schema calls energyTotal a
        lifetime accumulator; on this gateway it is not one — panel 1's energyTotal starts a
        day at zero and reaches 46,575 while the same panel's energyDaily peaks at 2,548 Wh,
        so it is neither lifetime nor watt-hours, and building hourly energy on it gave port
        totals ~30x the array's real output. energyDaily is a per-panel day counter that
        resets at midnight, hence measured from zero. energyTotal is still recorded
        untouched, because the lifetime query reads it.
      */
      const samples: RawSample[] = rows.map((row) => ({
        takenAt: row.takenAt,
        powerW: row.power,
        counter: row.energyDaily,
      }));
      for (const hour of bucketByHour(samples, SITE_TIMEZONE, 0)) {
        const data = {
          localDate: hour.localDate,
          avgPowerW: hour.avgPowerW,
          maxPowerW: hour.maxPowerW,
          energyWh: hour.energyWh,
          lastEnergyTotal: rows[rows.length - 1].energyTotal,
          samples: hour.samples,
          imported: hour.imported,
        };
        await this.prisma.portHourly.upsert({
          where: { pvPortId_hourStart: { pvPortId, hourStart: hour.hourStart } },
          create: { pvPortId, hourStart: hour.hourStart, ...data },
          update: data,
        });
      }
    }
  }

  /**
   * Does the rolled-up history still say what the raw history says? The gateway's day total
   * is MAX(dailyEnergy), which is how the whole app computes a day; the hourly rows must sum
   * to the same thing.
   */
  async verify(): Promise<number> {
    const [raw, rolled] = await Promise.all([
      this.prisma.dtuReading.groupBy({ by: ['localDate'], _max: { dailyEnergy: true } }),
      this.prisma.dtuHourly.groupBy({ by: ['localDate'], _sum: { energyWh: true } }),
    ]);
    const rolledBy = new Map(rolled.map((row) => [row.localDate, row._sum.energyWh ?? 0]));
    let disagreements = 0;
    for (const row of raw) {
      if (!rolledBy.has(row.localDate)) continue;
      const check = reconcile(row._max.dailyEnergy ?? 0, rolledBy.get(row.localDate) ?? 0);
      if (!check.agrees) {
        disagreements += 1;
        this.logger.warn(
          `Rollup mismatch on ${row.localDate}: hourly totals are ${check.differenceWh} Wh ` +
            `from the ${row._max.dailyEnergy} Wh the gateway reported`,
        );
      }
    }
    return disagreements;
  }
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}
