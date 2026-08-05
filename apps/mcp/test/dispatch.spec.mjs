import { describe, expect, it } from 'vitest';
import { DashboardError, createClient, normaliseBaseUrl } from '../src/dashboard.mjs';
import { createCallTool } from '../src/dispatch.mjs';

/*
  What happens when the dashboard cannot be reached is the load-bearing behaviour here. An
  assistant handed an empty object answers the question anyway, out of nothing, and sounds
  exactly as confident as it does with real figures.
*/

const clock = () => Date.parse('2026-08-04T12:00:00Z');

/** A client that serves canned bodies and fails everything else. */
function fakeClient(routes) {
  return {
    base: 'http://dash:3001',
    async get(path) {
      if (!(path in routes)) throw new DashboardError(`Could not reach the Solar Dashboard — nothing answers ${path}.`);
      const value = routes[path];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

const SUMMARY = {
  updatedAt: '2026-08-04T11:59:19Z',
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

describe('reachability', () => {
  it('reports an unreachable dashboard in words and refuses to estimate', async () => {
    const call = createCallTool({ client: fakeClient({}), clock });
    const result = await call('get_current_status', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not reach the Solar Dashboard');
  });

  it('still answers when only an optional read fails, and says which', async () => {
    /*
      Collector health is context, not the answer. A status route that fails must not
      suppress a perfectly good power reading — but the gap has to be visible, or "no
      charger" and "could not ask about the charger" become the same sentence.
    */
    const call = createCallTool({ client: fakeClient({ '/api/summary': SUMMARY }), clock });
    const result = await call('get_current_status', {});
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('4,180 W');
    expect(result.content[0].text).toContain('/api/status could not be read');
  });

  it('treats a house with no EV as a normal install', async () => {
    const call = createCallTool({ client: fakeClient({}), clock });
    const result = await call('get_ev_charging', {});
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('No vehicle data is available');
  });
});

describe('arguments', () => {
  it('refuses an out-of-range window here rather than sending a doomed request', async () => {
    const call = createCallTool({ client: fakeClient({}), clock });
    const result = await call('get_panel_health', { days: 400 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('between 1 and 90');
  });

  it('falls back to the documented default when an argument is omitted', async () => {
    const call = createCallTool({
      client: fakeClient({ '/api/analytics/panels?days=7': [] }),
      clock,
    });
    expect((await call('get_panel_health', {})).isError).toBe(false);
  });

  it('names an unknown tool instead of guessing at one', async () => {
    const result = await createCallTool({ client: fakeClient({}), clock })('drop_the_database', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});

describe('normaliseBaseUrl', () => {
  it('accepts the forms a person actually types', () => {
    expect(normaliseBaseUrl('10.0.0.140')).toBe('http://10.0.0.140:3001');
    expect(normaliseBaseUrl('10.0.0.140:3001')).toBe('http://10.0.0.140:3001');
    expect(normaliseBaseUrl('http://solar.local:3001/')).toBe('http://solar.local:3001');
    expect(normaliseBaseUrl('https://solar.example.com')).toBe('https://solar.example.com');
  });

  it('refuses an address it cannot use', () => {
    expect(() => normaliseBaseUrl('')).toThrow(DashboardError);
    expect(() => normaliseBaseUrl('   ')).toThrow(DashboardError);
  });
});

describe('the HTTP client', () => {
  const client = (fetchImpl) => createClient({ baseUrl: '10.0.0.140', fetchImpl, timeoutMs: 5000 });

  it('sends only GET', async () => {
    let seen = null;
    await client(async (url, init) => {
      seen = { url, method: init.method };
      return { ok: true, json: async () => ({}) };
    }).get('/api/summary');
    expect(seen).toEqual({ url: 'http://10.0.0.140:3001/api/summary', method: 'GET' });
  });

  it('turns a refused connection into an instruction', async () => {
    const error = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    await expect(client(async () => { throw error; }).get('/api/summary')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('names a timeout as a timeout', async () => {
    const error = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    await expect(client(async () => { throw error; }).get('/api/summary')).rejects.toThrow(/within 5s/);
  });

  it('explains a non-JSON body rather than throwing a parse error at the model', async () => {
    const bad = client(async () => ({ ok: true, json: async () => { throw new Error('Unexpected token <'); } }));
    await expect(bad.get('/api/summary')).rejects.toThrow(/points at a different service/);
  });

  it('reports an HTTP error with its status', async () => {
    const missing = client(async () => ({ ok: false, status: 404 }));
    await expect(missing.get('/api/charger')).rejects.toThrow(/answered 404/);
  });
});
