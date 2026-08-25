-- Hourly rollups, so the five-minute record can stop growing forever.
--
-- This array writes 9,870 PortReading rows a day and 3.6 million a year, against 273 a day
-- for the gateway's own totals. Nothing reads panel detail older than seven days except
-- somebody browsing back to a past day, and a day drawn at 24 points is still a day.
--
-- Rolled to the hour, panel history is 1,008 rows a day instead of 9,870. With the raw rows
-- purged behind a 90-day window the raw tables stop growing at all, and five years of history
-- is about 3.6 million rows rather than 24 million on a Pi.
--
-- WHAT THESE TABLES CARRY THAT AN AVERAGE WOULD NOT:
--
--   samples          how many readings the hour was built from. Twelve and three are
--                    different facts, and this app does not present a figure without being
--                    able to say what it rests on.
--   imported         how many of those came from a vendor export rather than a poll. The
--                    `source` column on the raw row is the audit trail; without this it dies
--                    with the rows it describes.
--   lastEnergyTotal  the lifetime counter at the end of the hour. The lifetime-energy query
--                    reads the newest raw row per port, so a panel that is retired and then
--                    ages past the retention window would otherwise take its lifetime
--                    production with it.

CREATE TABLE "PortHourly" (
    "pvPortId" INTEGER NOT NULL,
    "hourStart" DATETIME NOT NULL,
    "localDate" TEXT NOT NULL,
    "avgPowerW" REAL NOT NULL,
    "maxPowerW" REAL NOT NULL,
    "energyWh" INTEGER NOT NULL,
    "lastEnergyTotal" BIGINT NOT NULL,
    "samples" INTEGER NOT NULL,
    "imported" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("pvPortId", "hourStart"),
    CONSTRAINT "PortHourly_pvPortId_fkey" FOREIGN KEY ("pvPortId") REFERENCES "PvPort" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "PortHourly_localDate_idx" ON "PortHourly"("localDate");
CREATE INDEX "PortHourly_hourStart_idx" ON "PortHourly"("hourStart");

CREATE TABLE "DtuHourly" (
    "dtuId" INTEGER NOT NULL,
    "hourStart" DATETIME NOT NULL,
    "localDate" TEXT NOT NULL,
    "avgPowerW" REAL NOT NULL,
    "maxPowerW" REAL NOT NULL,
    "energyWh" INTEGER NOT NULL,
    "lastDailyEnergy" INTEGER NOT NULL,
    "samples" INTEGER NOT NULL,
    "imported" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("dtuId", "hourStart"),
    CONSTRAINT "DtuHourly_dtuId_fkey" FOREIGN KEY ("dtuId") REFERENCES "Dtu" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "DtuHourly_localDate_idx" ON "DtuHourly"("localDate");
CREATE INDEX "DtuHourly_hourStart_idx" ON "DtuHourly"("hourStart");
