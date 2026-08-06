#!/usr/bin/env node
/**
 * Fill a collection gap from a vendor cloud export, from a terminal.
 *
 * The dashboard records what it managed to poll. When the machine misses a window — Windows
 * Update rebooting at 02:22, or a wifi adapter that drops at 04:23 and does not come back —
 * the day's kWh survives, because the gateway's counter is cumulative and lives on the
 * gateway. The five-minute power history does not: it has a hole, and only the vendor's own
 * record can fill it.
 *
 * THE RULES ARE NOT IMPLEMENTED HERE. This posts the file to the running app, which applies
 * them in src/readings/cloud-import.ts, where they are unit-tested:
 *
 *  - imported rows are marked `source = 'cloud'`, so they never masquerade as your own
 *  - nothing is written where a real reading already sits, so re-running is a no-op
 *  - energy is integrated from the power in the file, so an import cannot inflate a day
 *
 * It used to open the database directly with Prisma, which was fine until somebody needed it
 * on a Raspberry Pi: the release ships one executable with no Node and no Prisma, so the
 * documented way to repair a gap could not be run on the machines that get them. Talking to
 * the API instead works from any machine that can reach the dashboard, and means there is
 * one implementation of the rules rather than two that merely look alike.
 *
 * Usage:
 *   node scripts/import-cloud-readings.mjs export.tsv --url http://solar.local:3001
 *   node scripts/import-cloud-readings.mjs export.tsv --url ... --commit
 *   node scripts/import-cloud-readings.mjs --undo --date 2026-08-06 --url ...
 *
 * Previews unless --commit is given. `--date YYYY-MM-DD` is only needed for older exports
 * that carry a bare "HH:MM" with no day; the timezone comes from the server's SITE_TIMEZONE,
 * which is the one that decides which day a reading counts toward.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const file = args[0] && !args[0].startsWith('--') ? args[0] : null;
const base = value('url', process.env.SOLAR_URL || 'http://localhost:3001').replace(/\/$/, '');
const localDate = value('date', null);
const commit = flag('commit');
const undo = flag('undo');

const headers = { 'Content-Type': 'text/plain' };
// Installs that set API_TOKEN guard every write. Without this the import is refused with a
// 401 that says nothing about which of the two machines is misconfigured.
if (process.env.API_TOKEN) headers.Authorization = `Bearer ${process.env.API_TOKEN}`;

const readBody = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // A proxy or a wrong URL answers with HTML, and "unexpected token <" helps nobody.
    throw new Error(`${base} answered ${response.status} with something that was not JSON.`);
  }
};

async function main() {
  if (undo) {
    if (!localDate) throw new Error('--undo needs --date YYYY-MM-DD');
    const response = await fetch(`${base}/api/readings/cloud-import?date=${localDate}`, {
      method: 'DELETE',
      headers,
    });
    const body = await readBody(response);
    if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
    console.log(`Removed ${body.removed} imported row(s) for ${localDate}.`);
    return;
  }

  if (!file) throw new Error('Give the export file as the first argument.');
  const text = readFileSync(file, 'utf8');

  const query = new URLSearchParams();
  if (commit) query.set('commit', 'true');
  if (localDate) query.set('date', localDate);

  const response = await fetch(`${base}/api/readings/cloud-import?${query}`, {
    method: 'POST',
    headers,
    body: text,
  });
  const plan = await readBody(response);
  if (!response.ok) throw new Error(plan.message ?? `HTTP ${response.status}`);

  if (!plan.inserted && !plan.covered) {
    console.log('No usable rows in that file.');
    return;
  }
  console.log(
    `${plan.inserted + plan.covered} point(s) read, ${plan.covered} already covered by real readings.`,
  );
  for (const day of plan.perDay) {
    console.log(
      `  ${day.date}: ${day.rows} row(s) to write, imported energy peaks at ` +
        `${day.importedPeakWh} Wh against ${day.recordedPeakWh} Wh already recorded.`,
    );
  }
  if (!plan.inserted) {
    console.log('Nothing to fill.');
    return;
  }
  console.log(
    plan.applied
      ? `Wrote ${plan.inserted} row(s) marked source="cloud". Undo with: --undo --date ${plan.dates[0]}`
      : `Would write ${plan.inserted} row(s) marked source="cloud". Re-run with --commit to apply.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
