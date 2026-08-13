import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Moving an existing install onto a Lite build.
 *
 * The Docker deployment applies migrations with the Prisma CLI, which records them in
 * `_prisma_migrations`. The Lite build keeps its own `_lite_migrations`, which such a file
 * will not have — so a database carried over reads as "nothing applied", the runner starts
 * again at the first migration, and it dies on `table "Dtu" already exists`. That happens
 * before the Nest app is created, so the whole service fails to boot, citing a table that
 * is perfectly fine.
 *
 * Found by taking a real snapshot off the running Docker install and trying it, an hour
 * before the Pi it was going to be moved to arrived.
 */

const migrationsDir = join(__dirname, '..', 'prisma', 'migrations');

/** A database migrated the way the Docker deployment migrates one. */
function prismaMigrated(): { dir: string; url: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lite-mig-'));
  const url = `file:${join(dir, 'solar.db')}`;
  // Resolved rather than assembled from path segments: pnpm stores the real package under
  // node_modules/.pnpm, so a hand-built relative path points at nothing.
  const cli = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [cli, 'migrate', 'deploy'], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  return { dir, url };
}

async function bookkeeping(url: string): Promise<{ prisma: number; lite: number }> {
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const count = async (table: string): Promise<number> => {
      try {
        const rows = await client.$queryRawUnsafe<Array<{ n: bigint | number }>>(
          `SELECT COUNT(*) AS n FROM "${table}"`,
        );
        return Number(rows[0].n);
      } catch {
        return -1;
      }
    };
    return { prisma: await count('_prisma_migrations'), lite: await count('_lite_migrations') };
  } finally {
    await client.$disconnect();
  }
}

describe('a database that Prisma CLI already migrated', () => {
  it('is adopted rather than replayed', async () => {
    const { dir, url } = prismaMigrated();
    try {
      const before = await bookkeeping(url);
      expect(before.prisma).toBeGreaterThan(0);
      expect(before.lite, 'the Lite table should not exist yet').toBe(-1);

      // The runner's own logic, driven with an explicit client so the test does not depend
      // on the packaged directory layout.
      const client = new PrismaClient({ datasources: { db: { url } } });
      await client.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS "_lite_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TEXT NOT NULL)',
      );
      const applied = new Set(
        (
          await client.$queryRawUnsafe<Array<{ name: string }>>(
            'SELECT "name" FROM "_lite_migrations"',
          )
        ).map((r) => r.name),
      );
      expect(applied.size, 'nothing recorded in the Lite table').toBe(0);

      const adopted = await client
        .$queryRawUnsafe<Array<{ migration_name: string }>>(
          'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL',
        )
        .catch(() => [] as Array<{ migration_name: string }>);
      expect(adopted.length, 'the CLI history is visible and adoptable').toBe(before.prisma);

      // Every migration on disk must be covered by what was adopted; if one is not, the
      // runner would try to apply it against a database that already has it.
      const onDisk = (await import('node:fs')).readdirSync(migrationsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      const names = new Set(adopted.map((a) => a.migration_name));
      expect([...onDisk].filter((name) => !names.has(name))).toEqual([]);

      await client.$disconnect();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
