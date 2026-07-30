import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Lite-build support: when packaged as a single executable, resources (web UI,
 * protobuf defs, migrations, the Prisma engine) and the SQLite file live in a
 * folder next to the executable rather than inside the source tree.
 */
export const isPackaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);

export const baseDir = isPackaged
  ? dirname(process.execPath)
  : join(__dirname, '..', '..'); // dist/common → apps/api

export function resourcePath(...segments: string[]): string {
  return join(baseDir, ...segments);
}

/**
 * Where state that outlives a build lives.
 *
 * Deploys and updates replace the install directory wholesale and exclude this, which is
 * exactly why the update handoff files belong here: a mechanism for surviving a bad update
 * cannot be stored somewhere an update overwrites.
 */
export function dataDir(): string {
  return process.env.SOLAR_DATA_DIR ?? resourcePath('data');
}

/** Prepare env for a packaged run: data dir, database URL, engine location. */
export function prepareLiteEnvironment(): void {
  if (!process.env.DATABASE_URL) {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    process.env.DATABASE_URL = `file:${join(dir, 'solar.db')}`;
  }
  if (isPackaged && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) {
    const engineDir = resourcePath('engine');
    if (existsSync(engineDir)) {
      const engine = readdirSync(engineDir).find(
        (file) => file.includes('query_engine') || file.includes('libquery_engine'),
      );
      if (engine) {
        process.env.PRISMA_QUERY_ENGINE_LIBRARY = join(engineDir, engine);
      }
    }
  }
}

/**
 * Minimal migration runner for packaged builds (no Prisma CLI on board).
 * Applies prisma/migrations SQL files in order, tracked in _lite_migrations.
 */
export async function runLiteMigrations(): Promise<void> {
  const migrationsDir = resourcePath('migrations');
  if (!existsSync(migrationsDir)) return;
  // Imported lazily so DATABASE_URL / engine env are set first.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "_lite_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TEXT NOT NULL)',
    );
    const applied = new Set(
      (
        await prisma.$queryRawUnsafe<Array<{ name: string }>>(
          'SELECT "name" FROM "_lite_migrations"',
        )
      ).map((row) => row.name),
    );
    const migrations = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of migrations) {
      if (applied.has(name)) continue;
      const sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
      const statements = sql
        .split(/;\s*[\r\n]/)
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement);
      }
      await prisma.$executeRawUnsafe(
        'INSERT INTO "_lite_migrations" ("name", "appliedAt") VALUES (?, ?)',
        name,
        new Date().toISOString(),
      );
      console.log(`migration applied: ${name}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
