-- Published monthly average retail fuel prices, cached locally.
--
-- The gas-comparison tile used to multiply a period's whole distance by one hardcoded
-- $1.60/L. Over eighteen months the published Saint John average ran 130.0¢ to 191.1¢, so
-- a flat current price does not misprice an old drive slightly — it misprices it by half.
-- Every drive already carries its own date; this is the dated price to meet it.
--
-- Stored rather than fetched on demand so that a drive from last March keeps being priced
-- at last March's figure whatever happens to the feed, and so the comparison still works
-- on a Pi with no internet.
CREATE TABLE "FuelPrice" (
  "id"            INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  "month"         TEXT     NOT NULL,
  "geography"     TEXT     NOT NULL,
  "centsPerLitre" REAL     NOT NULL,
  "source"        TEXT     NOT NULL DEFAULT 'statcan',
  "fetchedAt"     DATETIME NOT NULL
);

-- One row per source, place and month. The refresh is an upsert against this: a revised
-- figure replaces the one it revises instead of appending a second answer for one month.
-- `source` is part of the key so a weekly regulator feed, or prices the owner types in,
-- can sit beside the national series rather than silently overwriting it.
CREATE UNIQUE INDEX "FuelPrice_source_geography_month_key" ON "FuelPrice"("source", "geography", "month");
CREATE INDEX "FuelPrice_source_geography_idx" ON "FuelPrice"("source", "geography");
