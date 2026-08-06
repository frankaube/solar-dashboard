-- Self-consumption is the weakest number in this app: measurable only for solar sent to a
-- car or a battery, and otherwise a percentage the owner types in. A clamp on the service
-- entrance closes that by subtraction — what was made, minus what actually left the
-- property — without any appliance having to be identified or metered.
--
-- A device needs to be able to say it is that clamp. Nullable, because on almost every
-- install nothing is: a plug measuring one appliance says nothing about the house, and a
-- meter on a sub-panel is not the service entrance either.
ALTER TABLE "Device" ADD COLUMN "role" TEXT;

-- The learned system response, once a month.
--
-- Watts of AC per W/m² of irradiance is already computed for the expected-vs-actual chart,
-- and it is exactly what decays as panels age, with weather divided out by construction.
-- Its slope over years is this roof's degradation rate.
--
-- This table exists years before it can say anything, and that is deliberate: the figure
-- cannot be backfilled, because deriving it needs output paired with irradiance at the
-- time and nobody stores that from before they thought to. A month not recorded is gone.
CREATE TABLE "SystemResponseSnapshot" (
  "id"                 INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  "month"              TEXT     NOT NULL,
  "wattsPerIrradiance" REAL     NOT NULL,
  "samples"            INTEGER  NOT NULL,
  "ratedKw"            REAL,
  "recordedAt"         DATETIME NOT NULL
);

-- One row per month. The month in progress is rewritten as it fills, so the write is an
-- upsert against this index rather than an append that would leave thirty rows for August.
CREATE UNIQUE INDEX "SystemResponseSnapshot_month_key" ON "SystemResponseSnapshot"("month");
