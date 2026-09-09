-- DropIndex — an index this migration did not create, folded in by Prisma. Why it stays:
--
-- 20260729000000_reading_source created DtuReading_source_idx, but the schema never
-- declared @@index([source]), so the database and the schema had been out of step since.
-- Prisma noticed while generating this migration and included the correction.
--
-- Keeping it: nothing queries by source. The column marks rows imported from a vendor
-- export rather than polled, and it is read alongside the row, never filtered on. An index
-- nobody reads still costs a write on every reading insert — every five minutes, forever.
DROP INDEX "DtuReading_source_idx";

-- CreateTable
CREATE TABLE "CreditReading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "readAt" DATETIME NOT NULL,
    "balanceKwh" REAL NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CreditReading_readAt_idx" ON "CreditReading"("readAt");
