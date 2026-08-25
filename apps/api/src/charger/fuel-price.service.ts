import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FuelPricePoint } from './fuel-prices';
import { fetchPrices, isKnownGeography } from './statcan';

/**
 * Keeps a local copy of the published fuel-price series. Refreshes daily: the figure is
 * monthly and released about six weeks in arrears, but the release date is not announced.
 *
 * Nothing here deletes a stored price — a revision replaces the month it revises, a failed
 * fetch changes nothing — so an old drive keeps the figure published for its own month.
 */

/** How far back to keep. Longer than most people's driving history, cheap either way. */
const MONTHS = 48;
const REFRESH_MS = 24 * 60 * 60_000;
/** Late enough after boot that a restart loop cannot turn into a request loop. */
const FIRST_MS = 2 * 60_000;
export const SOURCE = 'statcan';

@Injectable()
export class FuelPriceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FuelPriceService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.first = setTimeout(() => void this.refresh(), FIRST_MS);
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  /**
   * Pull the series for a geography and store it. Returns rows written, or null when
   * nothing could be fetched — "could not reach Statistics Canada" is not "no prices found".
   */
  async refresh(geographyId?: string): Promise<number | null> {
    const geography = geographyId ?? (await this.configuredGeography());
    if (!geography) return null;

    let points;
    try {
      points = await fetchPrices(geography, MONTHS);
    } catch (error) {
      // Keep what is stored and try tomorrow: an unreachable source must not cost a series
      // that is already correct.
      this.logger.warn(`Could not refresh fuel prices: ${String(error)}`);
      return null;
    }

    let written = 0;
    for (const point of points) {
      await this.prisma.fuelPrice.upsert({
        where: { source_geography_month: { source: SOURCE, geography, month: point.month } },
        create: {
          source: SOURCE,
          geography,
          month: point.month,
          centsPerLitre: point.centsPerLitre,
          fetchedAt: new Date(),
        },
        update: { centsPerLitre: point.centsPerLitre, fetchedAt: new Date() },
      });
      written += 1;
    }
    if (written) this.logger.log(`Fuel prices: ${written} months stored for geography ${geography}.`);
    return written;
  }

  /** The stored series for the configured place, oldest first. Empty when none is set. */
  async series(): Promise<FuelPricePoint[]> {
    const geography = await this.configuredGeography();
    if (!geography) return [];
    const rows = await this.prisma.fuelPrice.findMany({
      where: { source: SOURCE, geography },
      orderBy: { month: 'asc' },
      select: { month: true, centsPerLitre: true },
    });
    return rows;
  }

  /** What the UI needs to describe the series without fetching it again. */
  async status(): Promise<{
    geography: string | null;
    months: number;
    newestMonth: string | null;
    newestCentsPerLitre: number | null;
    fetchedAt: string | null;
  }> {
    const geography = await this.configuredGeography();
    if (!geography) {
      return { geography: null, months: 0, newestMonth: null, newestCentsPerLitre: null, fetchedAt: null };
    }
    const [count, newest] = await Promise.all([
      this.prisma.fuelPrice.count({ where: { source: SOURCE, geography } }),
      this.prisma.fuelPrice.findFirst({
        where: { source: SOURCE, geography },
        orderBy: { month: 'desc' },
      }),
    ]);
    return {
      geography,
      months: count,
      newestMonth: newest?.month ?? null,
      newestCentsPerLitre: newest?.centsPerLitre ?? null,
      fetchedAt: newest?.fetchedAt.toISOString() ?? null,
    };
  }

  /** The owner's assumption about the petrol car being compared against. Null if unset. */
  async litresPer100Km(): Promise<number | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: GAS_LITRES_PER_100KM_KEY } });
    const value = Number(row?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  async setLitresPer100Km(litres: number): Promise<void> {
    await this.write(GAS_LITRES_PER_100KM_KEY, String(litres));
  }

  async setGeography(geographyId: string): Promise<void> {
    await this.write(FUEL_GEOGRAPHY_KEY, geographyId);
  }

  private async write(key: string, value: string): Promise<void> {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  /**
   * Null, not a default, when no place has been chosen: a guessed geography would price
   * drives at a pump three time zones away with nothing on the page to reveal it.
   */
  private async configuredGeography(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: FUEL_GEOGRAPHY_KEY } });
    const value = row?.value?.trim();
    return value && isKnownGeography(value) ? value : null;
  }
}

/** Settings key: which Statistics Canada geography to price against. */
export const FUEL_GEOGRAPHY_KEY = 'fuelGeography';
/** Settings key: litres per 100 km for the petrol car being compared against. */
export const GAS_LITRES_PER_100KM_KEY = 'gasLitresPer100Km';
