-- Home battery telemetry.
CREATE TABLE "BatteryReading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "takenAt" DATETIME NOT NULL,
    "soc" REAL NOT NULL,
    "powerW" REAL NOT NULL,
    "socLow" REAL
);
CREATE INDEX "BatteryReading_takenAt_idx" ON "BatteryReading"("takenAt");
