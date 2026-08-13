-- Repair localDate values written as M/D/YYYY instead of YYYY-MM-DD.
--
-- localDateOf() used Intl.DateTimeFormat('en-CA').format(), which renders ISO only where
-- the en-CA locale exists. The packaged Lite build ships small-icu, where it does not, so
-- it silently fell back to US formatting — and every daily and monthly rollup groups by
-- this column. The visible symptom was a month total of $1 while a single day showed
-- $1.08, because half the days no longer matched the pattern the query filters on.
--
-- Rewritten by parsing the string rather than recomputing from takenAt: recomputing would
-- need the site timezone, which this migration has no access to, and getting it wrong
-- would move readings between days. The string already carries the correct local date —
-- only its shape is wrong.
--
-- Idempotent: matching on '%/%' means a second run finds nothing left to do.
UPDATE "DtuReading"
SET "localDate" =
      substr("localDate", instr("localDate", '/') + instr(substr("localDate", instr("localDate", '/') + 1), '/') + 1)
      || '-'
      || printf('%02d', CAST(substr("localDate", 1, instr("localDate", '/') - 1) AS INTEGER))
      || '-'
      || printf('%02d', CAST(substr(substr("localDate", instr("localDate", '/') + 1), 1,
                                    instr(substr("localDate", instr("localDate", '/') + 1), '/') - 1) AS INTEGER))
WHERE "localDate" LIKE '%/%';
