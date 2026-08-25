-- Multi-channel meters: a Shelly Pro 3EM reports three independent legs, an Emporia
-- Vue sixteen circuits. One row per device could only ever hold one of them, so an
-- adopted whole-home meter would have recorded a single arbitrary channel.
-- Channel 0 stays the whole-device figure; channels 1..n are the individual legs.
ALTER TABLE "DeviceReading" ADD COLUMN "channel" INTEGER NOT NULL DEFAULT 0;

-- Meters count energy sent back to the grid separately from energy drawn. Netting
-- them into one number would erase exactly the split net-metering accounting needs.
ALTER TABLE "DeviceReading" ADD COLUMN "energyReturnedWh" REAL;

DROP INDEX IF EXISTS "DeviceReading_deviceId_takenAt_idx";
CREATE INDEX "DeviceReading_deviceId_channel_takenAt_idx"
  ON "DeviceReading"("deviceId", "channel", "takenAt");
