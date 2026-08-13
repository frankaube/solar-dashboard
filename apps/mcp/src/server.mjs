#!/usr/bin/env node
/**
 * The Solar Dashboard as an MCP server: ask an assistant about your own array.
 *
 * Runs as a child process of whatever MCP client spawns it — Claude Desktop, Claude Code,
 * anything else that speaks the protocol — and reaches the dashboard over HTTP on the
 * local network. Nothing leaves the house that the assistant is not already being asked.
 *
 *   SOLAR_DASHBOARD_URL   where the dashboard is. "10.0.0.140", "10.0.0.140:3001" and
 *                         "http://solar.local:3001" all work. Defaults to localhost:3001.
 *   SOLAR_MCP_TIMEOUT_MS  how long to wait for it. Defaults to 10000.
 *
 * Read-only. See tools.mjs for why that is a line and not an omission.
 */

import { createInterface } from 'node:readline';
import { createClient, DEFAULT_TIMEOUT_MS, DashboardError } from './dashboard.mjs';
import { createCallTool } from './dispatch.mjs';
import { handleLine } from './protocol.mjs';
import { describeTools } from './tools.mjs';

const VERSION = '0.1.0';

/**
 * What the client shows the model before it has called anything.
 *
 * Worth spending words on: the failure this server exists to avoid is an assistant that
 * answers "how much did I generate last month" from the shape of the question rather than
 * from the roof. Saying plainly that the tools are the only source, and that absent is not
 * zero, is cheaper than correcting it afterwards.
 */
const INSTRUCTIONS = [
  'This server reads one household\'s real solar, battery, EV-charging and home-energy data from a self-hosted Solar Dashboard.',
  '',
  'Every figure must come from a tool call. Do not estimate, extrapolate, or fill a gap from general knowledge about solar systems — if a tool says a value is unknown, it is unknown, and saying so is the correct answer.',
  '',
  'The tools distinguish measured figures from estimated ones, money actually kept from optimistic ceilings, and complete periods from part-periods. Carry those distinctions into your answer; they are the difference between a useful number and a confident wrong one.',
  '',
  'Everything here is read-only. Changing settings, acknowledging alerts and controlling devices are done in the dashboard itself.',
].join('\n');

/** stderr, never stdout: stdout is the protocol stream and must carry nothing else. */
const log = (message) => process.stderr.write(`[solar-mcp] ${message}\n`);

function main() {
  const baseUrl = process.env.SOLAR_DASHBOARD_URL ?? 'http://localhost:3001';
  const timeoutMs = Number(process.env.SOLAR_MCP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  let client;
  try {
    client = createClient({
      baseUrl,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    /*
      Exiting here rather than starting and failing every call. A misconfigured address is
      the one error the person running this can fix in ten seconds, and the client shows
      them our stderr when we refuse to start — but hides it when we start successfully
      and then answer every question with the same complaint.
    */
    log(error instanceof DashboardError ? error.message : String(error));
    log('Set SOLAR_DASHBOARD_URL to the dashboard address, for example 10.0.0.140:3001');
    process.exitCode = 1;
    return;
  }

  const deps = {
    serverInfo: { name: 'solar-dashboard', title: 'Solar Dashboard', version: VERSION },
    instructions: INSTRUCTIONS,
    tools: describeTools(),
    callTool: createCallTool({ client }),
  };

  log(`reading ${client.base}`);

  const input = createInterface({ input: process.stdin });
  /*
    Replies are chained rather than raced. The protocol allows concurrent requests, but a
    single dashboard on a Raspberry Pi gains nothing from four simultaneous scans of the
    reading table, and serialising keeps write order deterministic — which is what makes
    the transcript in a bug report readable.
  */
  let queue = Promise.resolve();
  input.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let response;
      try {
        response = await handleLine(line, deps);
      } catch (error) {
        log(`unhandled: ${error?.stack ?? error}`);
        return;
      }
      // One JSON object per line, and JSON.stringify escapes any newline inside a string,
      // so a rendered report full of line breaks stays a single protocol message.
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });

  // The client closing our stdin is how it says goodbye. Leave with whatever is in flight
  // finished, so a last answer is not truncated.
  input.on('close', () => {
    queue.finally(() => process.exit(0));
  });
}

main();
