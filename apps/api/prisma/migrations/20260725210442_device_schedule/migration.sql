-- CreateTable
CREATE TABLE "DeviceSchedule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "deviceId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "timeOfDay" TEXT,
    "offsetMin" INTEGER NOT NULL DEFAULT 0,
    "value" REAL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunDate" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceSchedule_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DeviceSchedule_deviceId_idx" ON "DeviceSchedule"("deviceId");
