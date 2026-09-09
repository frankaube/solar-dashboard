import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Street tiles for the car map, cached on this machine's disk. Google's terms forbid
 * proxying or caching tiles; OSM's licence permits fetch-and-cache, so the browser only ever
 * talks to this machine. Cached indefinitely — streets do not move. Off by default.
 */

export const MAP_ENABLED = 'map.enabled';

/** OSM policy: identifying User-Agent required, bulk downloading forbidden — nothing pre-fetches. */
const USER_AGENT = 'solar-dashboard (self-hosted home energy dashboard)';
const TILE_HOST = 'https://tile.openstreetmap.org';
const REQUEST_TIMEOUT_MS = 10_000;
/** Slippy-map limits. Beyond 19 OSM has no tiles; below 3 the whole world is four images. */
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;

@Injectable()
export class TilesService {
  private readonly logger = new Logger(TilesService.name);
  private readonly dir = join(process.env.DATA_DIR ?? './data', 'tiles');
  /** In-flight dedupe: twenty tiles of one map must not become twenty fetches. */
  private readonly pending = new Map<string, Promise<Buffer | null>>();

  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(): Promise<boolean> {
    const row = await this.prisma.setting.findUnique({ where: { key: MAP_ENABLED } });
    return row?.value === '1';
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key: MAP_ENABLED },
      create: { key: MAP_ENABLED, value: on ? '1' : '0' },
      update: { value: on ? '1' : '0' },
    });
  }

  /** Reject anything outside the slippy-map grid before it reaches the network. */
  private valid(z: number, x: number, y: number): boolean {
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
    if (z < MIN_ZOOM || z > MAX_ZOOM) return false;
    const limit = 2 ** z;
    return x >= 0 && x < limit && y >= 0 && y < limit;
  }

  /** Null (not a throw) when the map is off or the fetch fails; the caller answers 204. */
  async tile(z: number, x: number, y: number): Promise<Buffer | null> {
    if (!this.valid(z, x, y)) return null;
    if (!(await this.isEnabled())) return null;

    const file = join(this.dir, String(z), String(x), `${y}.png`);
    try {
      const info = await stat(file);
      if (info.size > 0) return await readFile(file);
    } catch {
      // Not cached.
    }

    const key = `${z}/${x}/${y}`;
    const existing = this.pending.get(key);
    if (existing) return existing;

    const job = this.fetchTile(z, x, y, file).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  private async fetchTile(z: number, x: number, y: number, file: string): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${TILE_HOST}/${z}/${x}/${y}.png`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`Tile ${z}/${x}/${y} returned ${response.status}`);
        return null;
      }
      const body = Buffer.from(await response.arrayBuffer());
      await mkdir(join(this.dir, String(z), String(x)), { recursive: true });
      await writeFile(file, body);
      return body;
    } catch (error) {
      this.logger.warn(`Tile ${z}/${x}/${y} failed: ${(error as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
