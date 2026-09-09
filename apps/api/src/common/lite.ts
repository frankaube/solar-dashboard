import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Packaged as a single executable, resources (web UI, protobuf defs, migrations, the Prisma
 * engine) and the SQLite file live next to the executable, not inside the source tree.
 */
export const isPackaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);

export const baseDir = isPackaged
  ? dirname(process.execPath)
  : join(__dirname, '..', '..'); // dist/common → apps/api

export function resourcePath(...segments: string[]): string {
  return join(baseDir, ...segments);
}

/**
 * State that outlives a build. Updates replace the install directory wholesale and exclude
 * this, which is why the update handoff files belong here.
 */
export function dataDir(): string {
  return process.env.SOLAR_DATA_DIR ?? resourcePath('data');
}

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

    /*
      Adopt rather than replay a history the Prisma CLI wrote: a database from the Docker
      deployment carries `_prisma_migrations` and not this runner's table, so it would read
      "nothing applied" and die on `table "Dtu" already exists`. Only when our own table is
      empty, since after that it is the authority.
    */
    if (applied.size === 0) {
      const adopted = await prisma
        .$queryRawUnsafe<Array<{ migration_name: string }>>(
          'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL',
        )
        .catch(() => [] as Array<{ migration_name: string }>); // no such table: a fresh database
      for (const row of adopted) {
        if (!row?.migration_name) continue;
        await prisma.$executeRawUnsafe(
          'INSERT OR IGNORE INTO "_lite_migrations" ("name", "appliedAt") VALUES (?, ?)',
          row.migration_name,
          new Date().toISOString(),
        );
        applied.add(row.migration_name);
      }
      if (adopted.length > 0) {
        console.log(`adopted ${adopted.length} migrations already applied by prisma migrate`);
      }
    }
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
