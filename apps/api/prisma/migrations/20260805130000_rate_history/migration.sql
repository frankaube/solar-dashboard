-- What a kilowatt-hour cost, on the day it was produced.
--
-- The price lived in a single settings row and was applied to all history, so the day a
-- utility raised its rate every figure the app had ever shown changed with it —
-- retroactively and silently. A savings total somebody wrote down last winter stopped
-- matching the one on screen, and nothing said why.
--
-- A rate is more than a price: sales tax changes too, rarely, and whether a typed figure
-- already includes it is a property of that entry rather than of the install. Somebody who
-- copied a pre-tax rate off an old bill and a tax-inclusive one off a new one has both, and
-- neither is wrong.
--
-- Empty on an existing install, deliberately. The app falls back to the settings row it has
-- always used, so nobody's numbers move on upgrade — they only start being priced by date
-- once a rate change is actually recorded.
CREATE TABLE "RateEntry" (
  "id"               INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  -- YYYY-MM-DD, site-local. The first day this rate applied.
  "effectiveFrom"    TEXT     NOT NULL,
  "pricePerKwh"      REAL     NOT NULL,
  "hstRate"          REAL     NOT NULL,
  "priceIncludesTax" BOOLEAN  NOT NULL DEFAULT 1,
  "note"             TEXT,
  "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One rate per start date. Recording the same change twice revises it rather than leaving
-- two rows whose order decides the answer.
CREATE UNIQUE INDEX "RateEntry_effectiveFrom_key" ON "RateEntry"("effectiveFrom");
