-- Fix: SQLite only auto-increments INTEGER PRIMARY KEY, not BIGINT. The reading
-- tables used BigInt ids, so every insert failed with a null-id violation.
-- Rebuild each with an INTEGER AUTOINCREMENT id, preserving all existing rows.
PRAGMA foreign_keys=OFF;

-- DtuReading
CREATE TABLE "new_DtuReading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dtuId" INTEGER NOT NULL,
    "takenAt" DATETIME NOT NULL,
    "localDate" TEXT NOT NULL,
    "totalPower" REAL NOT NULL,
    "dailyEnergy" INTEGER NOT NULL,
    CONSTRAINT "DtuReading_dtuId_fkey" FOREIGN KEY ("dtuId") REFERENCES "Dtu" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DtuReading" ("id","dtuId","takenAt","localDate","totalPower","dailyEnergy")
    SELECT "id","dtuId","takenAt","localDate","totalPower","dailyEnergy" FROM "DtuReading";
DROP TABLE "DtuReading";
ALTER TABLE "new_DtuReading" RENAME TO "DtuReading";
CREATE INDEX "DtuReading_dtuId_takenAt_idx" ON "DtuReading"("dtuId", "takenAt");
CREATE INDEX "DtuReading_takenAt_idx" ON "DtuReading"("takenAt");
CREATE INDEX "DtuReading_localDate_idx" ON "DtuReading"("localDate");

-- InverterReading
CREATE TABLE "new_InverterReading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "microinverterId" INTEGER NOT NULL,
    "takenAt" DATETIME NOT NULL,
    "gridVoltage" REAL NOT NULL,
    "gridFrequency" REAL NOT NULL,
    "activePower" REAL NOT NULL,
    "reactivePower" REAL NOT NULL,
    "current" REAL NOT NULL,
    "powerFactor" REAL NOT NULL,
    "temperature" REAL NOT NULL,
    "powerLimitPct" REAL,
    "warningNumber" INTEGER,
    "linkStatus" INTEGER,
    "rfSignal" INTEGER,
    CONSTRAINT "InverterReading_microinverterId_fkey" FOREIGN KEY ("microinverterId") REFERENCES "Microinverter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_InverterReading" ("id","microinverterId","takenAt","gridVoltage","gridFrequency","activePower","reactivePower","current","powerFactor","temperature","powerLimitPct","warningNumber","linkStatus","rfSignal")
    SELECT "id","microinverterId","takenAt","gridVoltage","gridFrequency","activePower","reactivePower","current","powerFactor","temperature","powerLimitPct","warningNumber","linkStatus","rfSignal" FROM "InverterReading";
DROP TABLE "InverterReading";
ALTER TABLE "new_InverterReading" RENAME TO "InverterReading";
CREATE INDEX "InverterReading_microinverterId_takenAt_idx" ON "InverterReading"("microinverterId", "takenAt");
CREATE INDEX "InverterReading_takenAt_idx" ON "InverterReading"("takenAt");

-- PortReading
CREATE TABLE "new_PortReading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pvPortId" INTEGER NOT NULL,
    "takenAt" DATETIME NOT NULL,
    "voltage" REAL NOT NULL,
    "current" REAL NOT NULL,
    "power" REAL NOT NULL,
    "energyDaily" INTEGER NOT NULL,
    "energyTotal" BIGINT NOT NULL,
    "errorCode" BIGINT,
    CONSTRAINT "PortReading_pvPortId_fkey" FOREIGN KEY ("pvPortId") REFERENCES "PvPort" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PortReading" ("id","pvPortId","takenAt","voltage","current","power","energyDaily","energyTotal","errorCode")
    SELECT "id","pvPortId","takenAt","voltage","current","power","energyDaily","energyTotal","errorCode" FROM "PortReading";
DROP TABLE "PortReading";
ALTER TABLE "new_PortReading" RENAME TO "PortReading";
CREATE INDEX "PortReading_pvPortId_takenAt_idx" ON "PortReading"("pvPortId", "takenAt");
CREATE INDEX "PortReading_takenAt_idx" ON "PortReading"("takenAt");

-- DeviceReading
CREATE TABLE "new_DeviceReading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "deviceId" INTEGER NOT NULL,
    "takenAt" DATETIME NOT NULL,
    "on" BOOLEAN,
    "powerW" REAL,
    "energyWh" REAL,
    "temperatureC" REAL,
    "setpointC" REAL,
    CONSTRAINT "DeviceReading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DeviceReading" ("id","deviceId","takenAt","on","powerW","energyWh","temperatureC","setpointC")
    SELECT "id","deviceId","takenAt","on","powerW","energyWh","temperatureC","setpointC" FROM "DeviceReading";
DROP TABLE "DeviceReading";
ALTER TABLE "new_DeviceReading" RENAME TO "DeviceReading";
CREATE INDEX "DeviceReading_deviceId_takenAt_idx" ON "DeviceReading"("deviceId", "takenAt");

PRAGMA foreign_keys=ON;
