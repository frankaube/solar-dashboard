-- Provenance for gateway readings.
--
-- Existing rows were all polled from the DTU by this app, so "dtu" is the correct
-- backfill for every one of them. Imported rows say so, and can be found, counted and
-- removed again on their own.
ALTER TABLE "DtuReading" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'dtu';
CREATE INDEX "DtuReading_source_idx" ON "DtuReading"("source");
