import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Demo-mode URL rewriting.
 *
 * The builder's endpoints are demo features and already live under /api/demo/, so
 * prefixing them again produced /api/demo/demo/... and a 404 — the builder hung on
 * "Loading the catalogue…" exactly when demo mode was on, which is the only time it
 * gets opened.
 */
describe('demoize', () => {
  beforeEach(() => {
    vi.resetModules();
    const store: Record<string, string> = { 'solar-demo-mode': 'on' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });

  async function urlFor(path: string): Promise<string> {
    const api = await import('../src/api');
    let seen = '';
    vi.stubGlobal('fetch', (u: string) => {
      seen = u;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    await api.fetchSummary().catch(() => undefined);
    // fetchSummary hits /api/summary; re-run through the same path for the target.
    vi.stubGlobal('fetch', (u: string) => {
      seen = u;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    if (path === '/api/demo/house/options') await api.fetchHouseOptions().catch(() => undefined);
    return seen;
  }

  it('redirects a normal read into the demo dataset', async () => {
    expect(await urlFor('/api/summary')).toBe('/api/demo/summary');
  });

  it('leaves an already-demo URL alone instead of doubling the prefix', async () => {
    expect(await urlFor('/api/demo/house/options')).toBe('/api/demo/house/options');
  });
});
