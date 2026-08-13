-- Persist thermostat call-for-heat. It already drove change detection but was never
-- stored, so heating transitions triggered rows that did not record the transition.
-- Nullable: only thermostats report it.
ALTER TABLE "DeviceReading" ADD COLUMN "heating" BOOLEAN;
