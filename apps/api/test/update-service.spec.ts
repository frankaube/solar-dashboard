import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateService } from '../src/updates/update.service';
import { bundleName, CHECKSUM_FILE, SIGNATURE_FILE } from '../src/updates/releases';

/**
 * Both cases here came from opening the panel in a browser and using it, after the unit
 * tests were green and the app had built cleanly. They are the reason that step is not
 * optional.
 */

function fakePrisma(seed: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null,
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        rows.set(where.key, update.value);
        return { key: where.key, value: update.value };
      },
    },
  };
}

/*
  A version stamp, because the service refuses to offer an update to a build it cannot
  identify — correctly. buildInfo() reads this path and caches on first call, and vitest
  gives each test file its own module registry, so writing it here is enough.

  Worth spelling out: an earlier draft of this file passed only because a stray version.json
  happened to be sitting in the package root. Deleting it turned three tests red, which is
  the right outcome — the tests were leaning on ambient state, not on anything they set up.
*/
const STAMP = join(__dirname, '..', 'version.json');
beforeAll(() => {
  writeFileSync(
    STAMP,
    JSON.stringify({ version: '0.1.0', commit: 'abc1234', builtAt: '2026-07-30T12:00:00Z' }),
  );
});
afterAll(() => rmSync(STAMP, { force: true }));

const data = mkdtempSync(join(tmpdir(), 'update-svc-data-'));
const feed = mkdtempSync(join(tmpdir(), 'update-svc-feed-'));
afterAll(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(feed, { recursive: true, force: true });
});

writeFileSync(
  join(feed, 'releases.json'),
  JSON.stringify([
    {
      tag_name: 'v9.9.9',
      published_at: '2026-08-01T00:00:00Z',
      assets: [bundleName(process.arch), CHECKSUM_FILE, SIGNATURE_FILE].map((name) => ({
        name,
        browser_download_url: name,
        size: 1024,
      })),
    },
  ]),
);

const make = (seed: Record<string, string> = {}): UpdateService =>
  new UpdateService(fakePrisma(seed) as never);

/*
  The service exercises the real update path, which is Linux-only by design — see the
  platform gate in `chooseUpdate`. Pinned so this suite tests the update logic rather than
  the machine it happens to run on: unpinned, every case here passes on CI and fails on a
  Windows or macOS laptop, which is the worst possible way for a test to be wrong.
*/
const realPlatform = process.platform;
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'linux' }));
afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

beforeEach(() => {
  process.env.SOLAR_DATA_DIR = data;
  process.env.UPDATE_FEED_DIR = feed;
});

describe('status before anything has been checked', () => {
  it('says so, rather than reporting an empty feed it never read', async () => {
    /*
      The bug: status() derived a decision from an empty release list whenever nothing had
      been checked yet, so switching the channel to Stable produced "No releases published
      on this channel yet" next to "Last checked never" — a conclusion about a feed nobody
      had opened. Same class of mistake as an unstamped build reporting a version number.
    */
    const service = make({ 'update.channel': 'stable' });
    const status = await service.status();
    expect(status.checkedAt).toBeNull();
    expect(status.reason).toBe('Not checked yet.');
    expect(status.reason).not.toMatch(/no releases published/i);
    expect(status.available).toBeNull();
  });

  it('still says checks are off when they are off', async () => {
    const status = await make().status();
    expect(status.reason).toMatch(/off/i);
  });
});

describe('saving the policy', () => {
  it('has already looked by the time it answers', async () => {
    // Firing the check without awaiting meant the response was built from the previous
    // decision, so turning updates on appeared to find nothing until you pressed a button.
    const service = make();
    const before = await service.status();
    expect(before.available).toBeNull();

    await service.savePolicy({ channel: 'stable' });
    const after = await service.status();
    expect(after.checkedAt).not.toBeNull();
    expect(after.available?.version).toBe('9.9.9');
    expect(after.reason).toMatch(/available/i);
  });

  it('switching off clears a queued install as well as stopping checks', async () => {
    const service = make();
    await service.savePolicy({ channel: 'stable' });
    expect((await service.requestInstall('9.9.9')).ok).toBe(true);
    expect(await service.pending()).toBe('9.9.9');

    await service.savePolicy({ channel: 'off' });
    expect(await service.pending()).toBeNull();
  });
});

describe('requesting an install', () => {
  it('refuses a version that is not the one on offer', async () => {
    const service = make();
    await service.savePolicy({ channel: 'stable' });
    const result = await service.requestInstall('1.2.3');
    expect(result.ok).toBe(false);
    expect(await service.pending()).toBeNull();
  });

  it('writes a request carrying a version and nothing else', async () => {
    const service = make();
    await service.savePolicy({ channel: 'stable' });
    await service.requestInstall('9.9.9');
    const body = JSON.parse(readFileSync(join(data, 'update-request.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(['requestedAt', 'version']);
  });
});
