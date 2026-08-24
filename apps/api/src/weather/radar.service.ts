import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WeatherService } from './weather.service';
import { RadarSource, SPAN_DEG, chooseSource, ecccUrl, rainviewerUrl } from './radar';
import { DrawnLine, boxFor, linesIn } from './coastline';

/**
 * Fetches the radar picture, so the browser never has to.
 *
 * Every other image in this app is drawn from local data. A tile fetched by the browser
 * would put the household's rough position into somebody else's request log on every page
 * load — a different kind of thing from an opt-in upload, and not one to do by accident. So
 * one machine talks outward, only when switched on, and serves the bytes on.
 *
 * Off by default. There is no reading of "the user probably wants this" that justifies
 * making an outbound request nobody asked for.
 */

export const RADAR_ENABLED = 'radar.enabled';
/** Radar composites refresh every six to ten minutes; asking faster gets the same picture. */
const CACHE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface RadarStatus {
  enabled: boolean;
  /** Null when no location is set — the picture needs somewhere to centre on. */
  source: RadarSource | null;
  updatedAt: string | null;
  error: string | null;
}

@Injectable()
export class RadarService {
  private readonly logger = new Logger(RadarService.name);
  private cached: { at: number; body: Buffer; type: string } | null = null;
  private error: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly weather: WeatherService,
  ) {}

  async enabled(): Promise<boolean> {
    const row = await this.prisma.setting.findUnique({ where: { key: RADAR_ENABLED } });
    return row?.value === '1';
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key: RADAR_ENABLED },
      create: { key: RADAR_ENABLED, value: on ? '1' : '0' },
      update: { value: on ? '1' : '0' },
    });
    if (!on) this.cached = null;
  }

  /**
   * Coastlines, borders and lakes for the box the picture covers.
   *
   * Empty when no location is set, because there is no box — and the panel draws nothing
   * rather than a coastline for somewhere the array is not.
   */
  async geography(): Promise<{ lines: DrawnLine[] }> {
    const location = await this.weather.getLocation();
    if (!location) return { lines: [] };
    return { lines: linesIn(boxFor(location.latitude, location.longitude, SPAN_DEG)) };
  }

  async status(): Promise<RadarStatus> {
    const location = await this.weather.getLocation();
    return {
      enabled: await this.enabled(),
      source: location ? chooseSource(location.latitude, location.longitude) : null,
      updatedAt: this.cached ? new Date(this.cached.at).toISOString() : null,
      error: this.error,
    };
  }

  /**
   * The newest frame RainViewer has, which its tile URLs are indexed by.
   *
   * Only called outside Canada. The identifier changes every ten minutes and a URL built
   * without one returns nothing at all.
   */
  private async newestRainviewerFrame(signal: AbortSignal): Promise<string | null> {
    const response = await fetch('https://api.rainviewer.com/public/weather-maps.json', { signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { radar?: { past?: Array<{ path?: string }> } };
    const past = body.radar?.past ?? [];
    return past.length ? (past[past.length - 1].path ?? null) : null;
  }

  /**
   * The image, or null.
   *
   * Null for every reason a caller cannot act on differently — switched off, no location,
   * the far end unreachable. `status()` carries the explanation; this carries bytes.
   */
  async image(): Promise<{ body: Buffer; type: string } | null> {
    if (!(await this.enabled())) return null;
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) {
      return { body: this.cached.body, type: this.cached.type };
    }
    const location = await this.weather.getLocation();
    if (!location) {
      this.error = 'No location set, so there is nowhere to centre the picture.';
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const source = chooseSource(location.latitude, location.longitude);
      let url: string;
      if (source === 'eccc') {
        url = ecccUrl({ ...location, size: 512 });
      } else {
        const frame = await this.newestRainviewerFrame(controller.signal);
        if (!frame) {
          this.error = 'No recent radar frame published.';
          return null;
        }
        url = rainviewerUrl(frame, location);
      }
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = response.headers.get('content-type') ?? 'image/png';
      const body = Buffer.from(await response.arrayBuffer());
      this.cached = { at: Date.now(), body, type };
      this.error = null;
      return { body, type };
    } catch (error) {
      this.error = (error as Error).message;
      this.logger.warn(`Radar fetch failed: ${this.error}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
