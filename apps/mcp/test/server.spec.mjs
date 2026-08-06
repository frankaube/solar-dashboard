import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
  The one test that runs the real thing: a real child process, a real HTTP dashboard, a
  real handshake over a real pipe.

  Everything else here is a pure function checked in isolation, which cannot catch the
  failure this transport actually has. stdio framing is one JSON object per line and stdout
  belongs to the protocol; a single stray console.log corrupts the stream, and the client
  reports a disconnection that names none of this. That bug is invisible to unit tests and
  obvious to this one.
*/

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

const SUMMARY = {
  updatedAt: new Date().toISOString(),
  currentPowerW: 4180,
  todayEnergyWh: 21_400,
  gridVoltage: 243,
  gridFrequency: 60,
  invertersOnline: 9,
  invertersTotal: 10,
  ratedKw: 8.4,
  ratedKwConfigured: true,
  panelsTotal: 42,
};

/** A dashboard that answers the two routes get_current_status asks for. */
function fakeDashboard() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const body =
      req.url === '/api/summary'
        ? SUMMARY
        : { build: {}, collector: { consecutiveFailures: 0 }, counts: {}, openAlerts: 0 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return { server, seen };
}

/**
 * Drive the child over stdio, one response per line.
 *
 * `next()` walks a cursor rather than counting pending waiters, so a turn that produces no
 * response — a notification, which must produce none — simply leaves the cursor where it
 * was instead of silently consuming the next real answer.
 */
function talk(child) {
  const responses = [];
  let cursor = 0;
  let wake = null;
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      responses.push(JSON.parse(line));
    }
    wake?.();
    wake = null;
  });
  return {
    responses,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    async next(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (responses.length <= cursor) {
        if (Date.now() > deadline) throw new Error('the server never answered');
        await new Promise((resolve) => {
          wake = resolve;
          setTimeout(resolve, 50);
        });
      }
      return responses[cursor++];
    },
  };
}

describe('the server as a process', () => {
  let dashboard;
  let child;
  let io;

  beforeAll(async () => {
    dashboard = fakeDashboard();
    dashboard.server.listen(0, '127.0.0.1');
    await once(dashboard.server, 'listening');
    const { port } = dashboard.server.address();

    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, SOLAR_DASHBOARD_URL: `http://127.0.0.1:${port}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    io = talk(child);
  });

  afterAll(async () => {
    child?.kill();
    dashboard.server.close();
  });

  it('completes the handshake and serves a tool call over a real pipe', async () => {
    io.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    const initialized = await io.next();
    expect(initialized.result.serverInfo.name).toBe('solar-dashboard');
    expect(initialized.result.protocolVersion).toBe('2025-06-18');
    expect(initialized.result.instructions).toContain('must come from a tool call');

    // A notification. If the server answers this, the length assertion below fails — and
    // some real clients treat the reply as a fatal protocol violation.
    io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    io.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = await io.next();
    expect(listed.id).toBe(2);
    expect(listed.result.tools.map((t) => t.name)).toContain('get_current_status');

    io.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_current_status', arguments: {} } });
    const called = await io.next();
    expect(called.id).toBe(3);
    expect(called.result.content[0].text).toContain('Producing now: 4,180 W');
    expect(io.responses).toHaveLength(3);
  });

  it('only ever issued GETs to the dashboard', async () => {
    expect(dashboard.seen.length).toBeGreaterThan(0);
    for (const request of dashboard.seen) expect(request).toMatch(/^GET /);
  });

  it('keeps diagnostics off stdout', async () => {
    // The server logs which dashboard it is reading at startup. That line must have gone
    // to stderr — if it reached stdout, the parses above would have thrown.
    const stderr = child.stderr.read()?.toString() ?? '';
    expect(stderr).toContain('[solar-mcp]');
  });

  it('survives a malformed line instead of ending the session', async () => {
    child.stdin.write('this is not json\n');
    expect((await io.next()).error.code).toBe(-32700);

    io.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
    const pong = await io.next();
    expect(pong.id).toBe(5);
    expect(pong.result).toEqual({});
  });
});
