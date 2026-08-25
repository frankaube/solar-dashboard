-- Energy so far today, for hardware that reports a resetting daily figure rather
-- than a lifetime counter. Daikin air conditioners do exactly this.
--
-- Deliberately NOT stored in energyWh. That column holds a monotonic counter, and a
-- daily value living there would be differenced across midnight into nonsense — the
-- same class of error as reading a resetting counter as a lifetime one.
ALTER TABLE "DeviceReading" ADD COLUMN "energyTodayWh" REAL;
