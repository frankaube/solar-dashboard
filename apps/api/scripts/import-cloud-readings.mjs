#!/usr/bin/env node
/**
 * Fill a collection gap from a vendor cloud export.
 *
 * The dashboard only records what it managed to poll. If the machine sleeps through a
 * sunrise — Windows Update reboots at 02:22 and the box does not wake until 07:28 — the
 * daily kWh total survives, because the gateway's counter is cumulative and lives on the
 * gateway. The five-minute power history does not: it simply has a hole.
 *
 * This imports the vendor's own export for that window. Three rules make it safe to run:
 *
 *  - Imported rows are marked `source = 'cloud'`. They are somebody else's measurement,
 *    and a chart that cannot tell them apart from your own is a chart nobody can audit.
 *  - It never writes where a real reading already exists, so it cannot overwrite what
 *    the app actually observed, and re-running it is a no-op rather than a duplicate.
 *  - --undo removes exactly what it added and nothing else.
 *
 * Usage:
 *   node scripts/import-cloud-readings.mjs <file.tsv> --date 2026-07-29 --zone America/Toronto
 *   node scripts/import-cloud-readings.mjs --undo --date 2026-07-29
 *   ...add --dry-run to see what it would do.
 *
 * Input is the "HH:MM<TAB>watts" the S-Miles export produces; a leading plant-name column
 * is ignored if present.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

// First positional only, so it can never be confused with a flag's value.
const file = args[0] && !args[0].startsWith('--') ? args[0] : null;
const localDate = value('date', null);
const zone = value('zone', process.env.SITE_TIMEZONE || 'UTC');
const dryRun = flag('dry-run');
const undo = flag('undo');

if (!localDate) {
  console.error('--date YYYY-MM-DD is required.');
  process.exit(1);
}

const prisma = new PrismaClient();

/**
 * The UTC instant for a local wall-clock time on the given day.
 *
 * Derived by asking Intl what a guessed instant looks like in the zone and correcting by
 * the difference, rather than hardcoding an offset. A fixed -3 would be wrong for half
 * the year and silently wrong on the two days it changes.
 */
function instantFor(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const seen = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(guess));
  const get = (t) => Number(seen.find((p) => p.type === t).value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return new Date(guess + (guess - asLocal));
}

async function main() {
  const dtu = await prisma.dtu.findFirst({ orderBy: { id: 'asc' } });
  if (!dtu) throw new Error('No DTU in the database — nothing to attach readings to.');

  if (undo) {
    const where = { source: 'cloud', localDate };
    const doomed = await prisma.dtuReading.count({ where });
    console.log(`${dryRun ? 'Would remove' : 'Removing'} ${doomed} imported row(s) for ${localDate}.`);
    if (!dryRun && doomed) await prisma.dtuReading.deleteMany({ where });
    return;
  }

  if (!file) throw new Error('Give the export file as the first argument.');
  const points = readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const cells = line.split('\t');
      // Tolerate the plant-name column the export puts in front.
      const [time, watts] = cells.length >= 3 ? cells.slice(-2) : cells;
      return { time: time.trim().slice(-5), watts: Number(watts) };
    })
    .filter((p) => /^\d\d:\d\d$/.test(p.time) && Number.isFinite(p.watts));

  if (!points.length) throw new Error('No usable rows in that file.');

  /*
    Energy is integrated from the start of the export rather than taken from it — the
    export carries power only. Every value therefore sits below the gateway's own daily
    counter, so importing cannot inflate the day's total, which is the one number here
    that was never damaged.
  */
  let wh = 0;
  const rows = points.map((p, i) => {
    if (i > 0) wh += ((points[i - 1].watts + p.watts) / 2) * (5 / 60);
    return { ...p, takenAt: instantFor(localDate, p.time), dailyEnergy: Math.round(wh) };
  });

  // Anything within this of a real reading is considered already covered.
  const NEAR_MS = 150_000;
  const existing = await prisma.dtuReading.findMany({
    where: { dtuId: dtu.id, localDate },
    select: { takenAt: true, source: true },
  });
  const covered = (at) =>
    existing.some((r) => Math.abs(new Date(r.takenAt).getTime() - at.getTime()) < NEAR_MS);

  const toInsert = rows.filter((r) => !covered(r.takenAt));
  const skipped = rows.length - toInsert.length;

  console.log(`${rows.length} point(s) in the export, ${skipped} already covered by real readings.`);
  if (!toInsert.length) {
    console.log('Nothing to fill.');
    return;
  }
  const first = toInsert[0], last = toInsert[toInsert.length - 1];
  console.log(
    `${dryRun ? 'Would insert' : 'Inserting'} ${toInsert.length} row(s) marked source="cloud", ` +
      `${first.time} to ${last.time} (${first.watts} W to ${last.watts} W).`,
  );
  if (dryRun) return;

  await prisma.dtuReading.createMany({
    data: toInsert.map((r) => ({
      dtuId: dtu.id,
      takenAt: r.takenAt,
      localDate,
      totalPower: r.watts,
      dailyEnergy: r.dailyEnergy,
      source: 'cloud',
    })),
  });
  console.log('Done. Undo with: --undo --date ' + localDate);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
