import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Site location, resolved from settings (or env at first boot) — never hardcoded.
 *
 * Two reasons this is not a constant. It is a real product limit: an app that aims to
 * cover every Canadian utility program cannot ship pinned to one town. And a fixed
 * lat/long in a public repository is the owner's home address to within ~100 m, which
 * no amount of key rotation or history rewriting takes back.
 *
 * With no location configured the weather feature stays off rather than guessing.
 * Someone else's forecast is worse than no forecast, because it looks like data.
 */
const LATITUDE_SETTING_KEY = 'siteLatitude';
const LONGITUDE_SETTING_KEY = 'siteLongitude';
const POLL_INTERVAL_MS = 15 * 60_000;
/** Today plus three days ahead — the weather card shows three forecast columns. */
const FORECAST_DAYS = 4;

const CURRENT_FIELDS = 'temperature_2m,cloud_cover,wind_speed_10m,weather_code,shortwave_radiation';
const HOURLY_FIELDS = 'temperature_2m,cloud_cover,shortwave_radiation,weather_code';
const DAILY_FIELDS =
  'sunrise,sunset,weather_code,temperature_2m_max,temperature_2m_min,shortwave_radiation_sum';

export interface CurrentWeatherDto {
  takenAt: string;
  temperature: number;
  cloudCover: number;
  windSpeed: number;
  weatherCode: number;
  shortwaveRadiation: number;
}

export interface HourlyForecastDto {
  time: string[];
  temperature: number[];
  cloudCover: number[];
  shortwaveRadiation: number[];
  weatherCode: number[];
}

export interface DailySunDto {
  sunrise: string[];
  sunset: string[];
}

/** One day of the forecast strip. `date` is the site-local calendar day. */
export interface DailyForecastDto {
  date: string;
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  /** Total daily irradiance (MJ/m²) — the honest predictor of tomorrow's yield. */
  radiationSum: number | null;
  sunrise: string | null;
  sunset: string | null;
}

interface OpenMeteoResponse {
  current: {
    time: string;
    temperature_2m: number;
    cloud_cover: number;
    wind_speed_10m: number;
    weather_code: number;
    shortwave_radiation: number;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    cloud_cover: number[];
    shortwave_radiation: number[];
    weather_code: number[];
  };
  daily: DailySunDto & {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    shortwave_radiation_sum?: (number | null)[];
  };
}

@Injectable()
export class WeatherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WeatherService.name);
  private timer: NodeJS.Timeout | null = null;
  private current: CurrentWeatherDto | null = null;
  private hourly: HourlyForecastDto | null = null;
  private daily: DailySunDto | null = null;
  private forecast: DailyForecastDto[] = [];
  private warnedNoLocation = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getWeather(): {
    current: CurrentWeatherDto | null;
    hourly: HourlyForecastDto | null;
    daily: DailySunDto | null;
    forecast: DailyForecastDto[];
  } {
    return {
      current: this.current,
      hourly: this.hourly,
      daily: this.daily,
      forecast: this.forecast,
    };
  }

  /**
   * Configured site coordinates, or null when the site has not been located yet.
   * Settings win over env so the UI can change location without a restart; env exists
   * so a fresh container can be seeded without clicking through onboarding.
   */
  async getLocation(): Promise<{ latitude: number; longitude: number } | null> {
    const read = async (key: string, envKey: string): Promise<number | null> => {
      const setting = await this.prisma.setting.findUnique({ where: { key } });
      const raw = setting?.value ?? process.env[envKey];
      const value = raw === undefined ? NaN : Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    const latitude = await read(LATITUDE_SETTING_KEY, 'SITE_LATITUDE');
    const longitude = await read(LONGITUDE_SETTING_KEY, 'SITE_LONGITUDE');
    if (latitude === null || longitude === null) return null;
    // Reject impossible coordinates rather than sending them upstream.
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude };
  }

  async setLocation(latitude: number, longitude: number): Promise<void> {
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new Error('invalid latitude');
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error('invalid longitude');
    for (const [key, value] of [
      [LATITUDE_SETTING_KEY, latitude],
      [LONGITUDE_SETTING_KEY, longitude],
    ] as const) {
      await this.prisma.setting.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
      });
    }
    await this.poll(); // reflect the new site immediately rather than after 15 min
  }

  private buildUrl(location: { latitude: number; longitude: number }): string {
    const params = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: CURRENT_FIELDS,
      hourly: HOURLY_FIELDS,
      daily: DAILY_FIELDS,
      forecast_days: String(FORECAST_DAYS),
      timezone: 'auto',
    });
    return `https://api.open-meteo.com/v1/forecast?${params}`;
  }

  private async poll(): Promise<void> {
    try {
      const location = await this.getLocation();
      if (!location) {
        // Warn once, not every 15 minutes — an unconfigured site is a normal state
        // for a fresh install, not a recurring fault.
        if (!this.warnedNoLocation) {
          this.logger.log('No site location set — weather is off until one is configured.');
          this.warnedNoLocation = true;
        }
        return;
      }
      this.warnedNoLocation = false;
      const response = await fetch(this.buildUrl(location));
      if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
      const body = (await response.json()) as OpenMeteoResponse;

      this.current = {
        takenAt: body.current.time,
        temperature: body.current.temperature_2m,
        cloudCover: body.current.cloud_cover,
        windSpeed: body.current.wind_speed_10m,
        weatherCode: body.current.weather_code,
        shortwaveRadiation: body.current.shortwave_radiation,
      };
      this.hourly = {
        time: body.hourly.time,
        temperature: body.hourly.temperature_2m,
        cloudCover: body.hourly.cloud_cover,
        shortwaveRadiation: body.hourly.shortwave_radiation,
        weatherCode: body.hourly.weather_code,
      };
      this.daily = body.daily ?? null;

      // Open-Meteo returns the daily block as parallel arrays; zip them into rows so
      // the UI never has to index-match. Day 0 is today.
      const days = body.daily?.time ?? [];
      this.forecast = days.map((date, i) => ({
        date,
        weatherCode: body.daily.weather_code?.[i] ?? 0,
        tempMax: body.daily.temperature_2m_max?.[i] ?? 0,
        tempMin: body.daily.temperature_2m_min?.[i] ?? 0,
        radiationSum: body.daily.shortwave_radiation_sum?.[i] ?? null,
        sunrise: body.daily.sunrise?.[i] ?? null,
        sunset: body.daily.sunset?.[i] ?? null,
      }));

      await this.prisma.weatherReading.create({
        data: {
          takenAt: new Date(),
          temperature: body.current.temperature_2m,
          cloudCover: body.current.cloud_cover,
          windSpeed: body.current.wind_speed_10m,
          shortwaveRadiation: body.current.shortwave_radiation,
          weatherCode: body.current.weather_code,
        },
      });
    } catch (error) {
      this.logger.warn(`Weather poll failed: ${(error as Error).message}`);
    }
  }
}
