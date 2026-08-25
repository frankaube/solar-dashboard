-- CreateTable
CREATE TABLE "Dtu" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "serialNumber" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "model" TEXT,
    "hardwareVersion" TEXT,
    "softwareVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Microinverter" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dtuId" INTEGER NOT NULL,
    "serialNumber" BIGINT NOT NULL,
    "model" TEXT,
    "portCount" INTEGER NOT NULL,
    "firmware" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Microinverter_dtuId_fkey" FOREIGN KEY ("dtuId") REFERENCES "Dtu" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PvPort" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "microinverterId" INTEGER NOT NULL,
    "portNumber" INTEGER NOT NULL,
    "panelLabel" TEXT,
    "panelWattage" INTEGER,
    "gridX" INTEGER,
    "gridY" INTEGER,
    CONSTRAINT "PvPort_microinverterId_fkey" FOREIGN KEY ("microinverterId") REFERENCES "Microinverter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InverterReading" (
    "id" BIGINT NOT NULL PRIMARY KEY,
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

-- CreateTable
CREATE TABLE "PortReading" (
    "id" BIGINT NOT NULL PRIMARY KEY,
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

-- CreateTable
CREATE TABLE "DtuReading" (
    "id" BIGINT NOT NULL PRIMARY KEY,
    "dtuId" INTEGER NOT NULL,
    "takenAt" DATETIME NOT NULL,
    "localDate" TEXT NOT NULL,
    "totalPower" REAL NOT NULL,
    "dailyEnergy" INTEGER NOT NULL,
    CONSTRAINT "DtuReading_dtuId_fkey" FOREIGN KEY ("dtuId") REFERENCES "Dtu" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "ackedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ChargerReading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "takenAt" DATETIME NOT NULL,
    "vehicleConnected" BOOLEAN NOT NULL,
    "charging" BOOLEAN NOT NULL,
    "power" REAL NOT NULL,
    "sessionEnergyWh" REAL NOT NULL,
    "gridVoltage" REAL NOT NULL,
    "handleTemp" REAL
);

-- CreateTable
CREATE TABLE "WeatherReading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "takenAt" DATETIME NOT NULL,
    "temperature" REAL NOT NULL,
    "cloudCover" INTEGER NOT NULL,
    "windSpeed" REAL,
    "shortwaveRadiation" REAL,
    "weatherCode" INTEGER
);

-- CreateIndex
CREATE UNIQUE INDEX "Dtu_serialNumber_key" ON "Dtu"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Microinverter_serialNumber_key" ON "Microinverter"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PvPort_microinverterId_portNumber_key" ON "PvPort"("microinverterId", "portNumber");

-- CreateIndex
CREATE INDEX "InverterReading_microinverterId_takenAt_idx" ON "InverterReading"("microinverterId", "takenAt");

-- CreateIndex
CREATE INDEX "InverterReading_takenAt_idx" ON "InverterReading"("takenAt");

-- CreateIndex
CREATE INDEX "PortReading_pvPortId_takenAt_idx" ON "PortReading"("pvPortId", "takenAt");

-- CreateIndex
CREATE INDEX "PortReading_takenAt_idx" ON "PortReading"("takenAt");

-- CreateIndex
CREATE INDEX "DtuReading_dtuId_takenAt_idx" ON "DtuReading"("dtuId", "takenAt");

-- CreateIndex
CREATE INDEX "DtuReading_takenAt_idx" ON "DtuReading"("takenAt");

-- CreateIndex
CREATE INDEX "DtuReading_localDate_idx" ON "DtuReading"("localDate");

-- CreateIndex
CREATE INDEX "Alert_closedAt_idx" ON "Alert"("closedAt");

-- CreateIndex
CREATE INDEX "Alert_subjectKey_idx" ON "Alert"("subjectKey");

-- CreateIndex
CREATE INDEX "ChargerReading_takenAt_idx" ON "ChargerReading"("takenAt");

-- CreateIndex
CREATE INDEX "WeatherReading_takenAt_idx" ON "WeatherReading"("takenAt");
