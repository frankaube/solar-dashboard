-- The utility's own meter, imported from their usage export.
--
-- Self-consumption has been the weakest number in this app: measurable only for solar sent
-- to a car or a battery, and otherwise a percentage typed into Settings. A clamp on the
-- service entrance fixes that going forward. This fixes it *backwards*, for anyone whose
-- utility publishes daily import and export — which is the same measurement, taken by the
-- meter the bill is calculated from, and available the day the panels go live.
--
-- `unmetered` exists because of a real case: four days when the array produced 367 kWh and
-- the meter recorded no export at all, because net metering had not been activated yet.
-- Taken at face value that reads as perfect self-consumption — crediting the house with
-- every kilowatt-hour it actually gave away, and inflating the savings figure at exactly
-- the moment the owner was being short-changed. Flagged rather than corrected: the app
-- cannot know which it was, only that it must not average it in.
CREATE TABLE "UtilityReading" (
  "id"          INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  "date"        TEXT     NOT NULL,
  "importedKwh" REAL     NOT NULL,
  "exportedKwh" REAL     NOT NULL,
  "source"      TEXT     NOT NULL,
  "unmetered"   BOOLEAN  NOT NULL DEFAULT 0,
  "importedAt"  DATETIME NOT NULL
);

-- One row per day. Re-importing an overlapping period revises those days rather than
-- appending a second answer for each of them.
CREATE UNIQUE INDEX "UtilityReading_date_key" ON "UtilityReading"("date");
CREATE INDEX "UtilityReading_date_idx" ON "UtilityReading"("date");
