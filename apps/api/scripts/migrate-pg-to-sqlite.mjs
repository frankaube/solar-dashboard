// One-time data migration: Postgres (old core db) -> SQLite (Lite foundation).
// Run from apps/api with DATABASE_URL pointing at the SQLite file:
//   node ../../scripts/migrate-pg-to-sqlite.mjs "postgresql://hoymiles:hoymiles_dev@localhost:5433/hoymiles"
import pg from 'pg';
import { PrismaClient } from '@prisma/client';

/*
  Re-buckets every migrated row by local date, so it has to agree with the running
  app. Hardcoding a zone here would rewrite someone else's history into the wrong days
  during the one operation where it is least likely to be noticed — the rows would be
  wrong from the moment they landed, with nothing to compare them against.
*/
const SITE_TIMEZONE =
  process.env.SITE_TIMEZONE?.trim() ||
  process.env.TZ?.trim() ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  'UTC';
console.log(`bucketing migrated rows by ${SITE_TIMEZONE} — set SITE_TIMEZONE to change`);
const localDateOf = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TIMEZONE }).format(date);

const pgUrl = process.argv[2];
if (!pgUrl) {
  console.error('usage: node migrate-pg-to-sqlite.mjs <postgres-url>');
  process.exit(1);
}

const source = new pg.Pool({ connectionString: pgUrl });
const prisma = new PrismaClient();

const num = (v) => (v === null || v === undefined ? null : Number(v));

async function copy(label, query, insert) {
  const { rows } = await source.query(query);
  if (rows.length) await insert(rows);
  console.log(`${label}: ${rows.length}`);
}

await copy('Dtu', 'SELECT * FROM "Dtu"', (rows) =>
  prisma.dtu.createMany({
    data: rows.map((r) => ({
      id: r.id,
      serialNumber: r.serialNumber,
      host: r.host,
      model: r.model,
      hardwareVersion: r.hardwareVersion,
      softwareVersion: r.softwareVersion,
      createdAt: r.createdAt,
    })),
  }),
);
await copy('Microinverter', 'SELECT * FROM "Microinverter"', (rows) =>
  prisma.microinverter.createMany({
    data: rows.map((r) => ({
      id: r.id,
      dtuId: r.dtuId,
      serialNumber: BigInt(r.serialNumber),
      model: r.model,
      portCount: r.portCount,
      firmware: r.firmware,
      createdAt: r.createdAt,
    })),
  }),
);
await copy('PvPort', 'SELECT * FROM "PvPort"', (rows) =>
  prisma.pvPort.createMany({
    data: rows.map((r) => ({
      id: r.id,
      microinverterId: r.microinverterId,
      portNumber: r.portNumber,
      panelLabel: r.panelLabel,
      panelWattage: r.panelWattage,
      gridX: r.gridX,
      gridY: r.gridY,
    })),
  }),
);
await copy('DtuReading', 'SELECT * FROM "DtuReading" ORDER BY id', (rows) =>
  prisma.dtuReading.createMany({
    data: rows.map((r) => ({
      id: BigInt(r.id),
      dtuId: r.dtuId,
      takenAt: r.takenAt,
      localDate: localDateOf(r.takenAt),
      totalPower: num(r.totalPower),
      dailyEnergy: r.dailyEnergy,
    })),
  }),
);
await copy('InverterReading', 'SELECT * FROM "InverterReading" ORDER BY id', (rows) =>
  prisma.inverterReading.createMany({
    data: rows.map((r) => ({
      id: BigInt(r.id),
      microinverterId: r.microinverterId,
      takenAt: r.takenAt,
      gridVoltage: num(r.gridVoltage),
      gridFrequency: num(r.gridFrequency),
      activePower: num(r.activePower),
      reactivePower: num(r.reactivePower),
      current: num(r.current),
      powerFactor: num(r.powerFactor),
      temperature: num(r.temperature),
      powerLimitPct: num(r.powerLimitPct),
      warningNumber: r.warningNumber,
      linkStatus: r.linkStatus,
      rfSignal: r.rfSignal,
    })),
  }),
);
await copy('PortReading', 'SELECT * FROM "PortReading" ORDER BY id', (rows) =>
  prisma.portReading.createMany({
    data: rows.map((r) => ({
      id: BigInt(r.id),
      pvPortId: r.pvPortId,
      takenAt: r.takenAt,
      voltage: num(r.voltage),
      current: num(r.current),
      power: num(r.power),
      energyDaily: r.energyDaily,
      energyTotal: BigInt(r.energyTotal),
      errorCode: r.errorCode === null ? null : BigInt(r.errorCode),
    })),
  }),
);
await copy('ChargerReading', 'SELECT * FROM "ChargerReading" ORDER BY id', (rows) =>
  prisma.chargerReading.createMany({
    data: rows.map((r) => ({
      id: r.id,
      takenAt: r.takenAt,
      vehicleConnected: r.vehicleConnected,
      charging: r.charging,
      power: num(r.power),
      sessionEnergyWh: num(r.sessionEnergyWh),
      gridVoltage: num(r.gridVoltage),
      handleTemp: num(r.handleTemp),
    })),
  }),
);
await copy('WeatherReading', 'SELECT * FROM "WeatherReading" ORDER BY id', (rows) =>
  prisma.weatherReading.createMany({
    data: rows.map((r) => ({
      id: r.id,
      takenAt: r.takenAt,
      temperature: num(r.temperature),
      cloudCover: r.cloudCover,
      windSpeed: num(r.windSpeed),
      shortwaveRadiation: num(r.shortwaveRadiation),
      weatherCode: r.weatherCode,
    })),
  }),
);
await copy('Alert', 'SELECT * FROM "Alert" ORDER BY id', (rows) =>
  prisma.alert.createMany({
    data: rows.map((r) => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      subjectKey: r.subjectKey,
      message: r.message,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      ackedAt: r.ackedAt,
    })),
  }),
);
await copy('Setting', 'SELECT * FROM "Setting"', (rows) =>
  prisma.setting.createMany({
    data: rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt })),
  }),
);

await source.end();
await prisma.$disconnect();
console.log('done');
