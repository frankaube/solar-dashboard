-- CreateTable
CREATE TABLE "Device" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "vendor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "hardwareId" TEXT,
    "room" TEXT,
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DeviceReading" (
    "id" BIGINT NOT NULL PRIMARY KEY,
    "deviceId" INTEGER NOT NULL,
    "takenAt" DATETIME NOT NULL,
    "on" BOOLEAN,
    "powerW" REAL,
    "energyWh" REAL,
    "temperatureC" REAL,
    "setpointC" REAL,
    CONSTRAINT "DeviceReading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_vendor_hardwareId_key" ON "Device"("vendor", "hardwareId");

-- CreateIndex
CREATE INDEX "DeviceReading_deviceId_takenAt_idx" ON "DeviceReading"("deviceId", "takenAt");
