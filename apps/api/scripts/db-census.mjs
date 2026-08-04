// What a database actually contains, for comparing one install against another.
//
//   DATABASE_URL="file:/path/to/solar.db" node scripts/db-census.mjs
//
// Written for a migration, and the reason it exists is the reason the README says to
// check rather than assume: "the dashboard came up" is not evidence the history arrived.
// A fresh empty database also comes up, looks fine, and shows today's readings — the
// difference only appears in the row counts and the earliest date, which is exactly what
// nobody thinks to look at until a week later.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const tables = [
  ['dtu', () => prisma.dtu.count()],
  ['microinverter', () => prisma.microinverter.count()],
  ['pvPort', () => prisma.pvPort.count()],
  ['inverterReading', () => prisma.inverterReading.count()],
  ['portReading', () => prisma.portReading.count()],
  ['dtuReading', () => prisma.dtuReading.count()],
  ['device', () => prisma.device.count()],
  ['deviceReading', () => prisma.deviceReading.count()],
  ['chargerReading', () => prisma.chargerReading.count()],
  ['batteryReading', () => prisma.batteryReading.count()],
  ['weatherReading', () => prisma.weatherReading.count()],
  ['alert', () => prisma.alert.count()],
  ['setting', () => prisma.setting.count()],
];

const counts = {};
for (const [name, count] of tables) {
  try {
    counts[name] = await count();
  } catch (error) {
    counts[name] = `ERROR: ${error.message.split('\n')[0]}`;
  }
}

// The span matters as much as the totals: equal row counts with a different first date
// would mean the wrong file was copied.
let span = null;
try {
  const [first, last] = await Promise.all([
    prisma.dtuReading.findFirst({ orderBy: { takenAt: 'asc' }, select: { takenAt: true } }),
    prisma.dtuReading.findFirst({ orderBy: { takenAt: 'desc' }, select: { takenAt: true } }),
  ]);
  if (first && last) {
    span = {
      first: first.takenAt.toISOString(),
      last: last.takenAt.toISOString(),
      days: Math.round((last.takenAt - first.takenAt) / 86_400_000),
    };
  }
} catch {
  // An older schema without this table is not a reason to fail the whole census.
}

const total = Object.values(counts)
  .filter((v) => typeof v === 'number')
  .reduce((a, b) => a + b, 0);

console.log(JSON.stringify({ counts, span, totalRows: total }, null, 2));
await prisma.$disconnect();
