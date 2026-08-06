import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_POLICY,
  describeState,
  normaliseHour,
  parsePolicy,
  parseRequest,
  parseState,
  serialisePolicy,
  serialiseRequest,
} from '../src/updates/handoff';
import { fetchFeed, resolveFeed } from '../src/updates/feed';
import { CHECKSUM_FILE, SIGNATURE_FILE, bundleName } from '../src/updates/releases';

const scratch = mkdtempSync(join(tmpdir(), 'update-feed-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('parsePolicy', () => {
  it('round-trips what the app writes', () => {
    const policy = { channel: 'stable' as const, apply: true, hour: 2 };
    expect(parsePolicy(serialisePolicy(policy))).toEqual(policy);
  });

  it('falls back to safe defaults on anything unreadable', () => {
    // The updater reads this at 3 AM. A crash there is indistinguishable from working, so
    // a corrupt policy has to mean "the safe default", never an exception.
    for (const bad of ['', '{', 'null', '[]', 'true', null, undefined]) {
      expect(parsePolicy(bad as string)).toEqual(DEFAULT_POLICY);
    }
  });

  it('defaults to off and notify-only', () => {
    expect(DEFAULT_POLICY.channel).toBe('off');
    expect(DEFAULT_POLICY.apply).toBe(false);
  });

  it('treats anything but a literal true as notify-only', () => {
    // "apply": "yes" must not arm an unattended install.
    for (const value of ['true', 1, 'yes', {}, null]) {
      expect(parsePolicy(JSON.stringify({ apply: value })).apply).toBe(false);
    }
    expect(parsePolicy(JSON.stringify({ apply: true })).apply).toBe(true);
  });

  it('rejects an unknown channel rather than inventing one', () => {
    expect(parsePolicy('{"channel":"nightly"}').channel).toBe('off');
  });

  it('clamps the hour, and tells absent apart from midnight', () => {
    expect(normaliseHour(null)).toBe(DEFAULT_POLICY.hour);
    expect(normaliseHour('')).toBe(DEFAULT_POLICY.hour);
    expect(normaliseHour(25)).toBe(DEFAULT_POLICY.hour);
    expect(normaliseHour(-1)).toBe(DEFAULT_POLICY.hour);
    expect(normaliseHour(0)).toBe(0);
    expect(normaliseHour('14')).toBe(14);
  });
});

describe('parseRequest', () => {
  it('round-trips', () => {
    const request = { version: '0.2.0', requestedAt: '2026-08-01T02:00:00.000Z' };
    expect(parseRequest(serialiseRequest(request))).toEqual(request);
  });

  it('refuses a request with no version', () => {
    // An empty version would read as "install whatever you find", which is the single
    // thing this format exists to prevent.
    for (const bad of ['{}', '{"version":""}', '{"version":"   "}', '{"version":42}', '[]', 'x']) {
      expect(parseRequest(bad)).toBeNull();
    }
  });

  it('carries a version and nothing else that could redirect a download', () => {
    const body = serialiseRequest({ version: '0.2.0', requestedAt: 'now' });
    const raw = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['requestedAt', 'version']);
    // Specifically: no url, no asset, no feed. Root resolves those itself.
    for (const key of ['url', 'asset', 'feed', 'source', 'path']) {
      expect(raw[key]).toBeUndefined();
    }
  });
});

describe('parseState / describeState', () => {
  it('reads what the updater writes', () => {
    const state = parseState(
      JSON.stringify({
        startedAt: '2026-08-01T02:00:00Z',
        finishedAt: '2026-08-01T02:01:30Z',
        fromVersion: '0.1.0',
        fromCommit: 'cf8067e',
        toVersion: '0.2.0',
        result: 'ok',
        checkedAt: '2026-08-01T02:00:00Z',
      }),
    );
    expect(state).toMatchObject({ result: 'ok', fromVersion: '0.1.0', toVersion: '0.2.0' });
    expect(describeState(state)).toBe('Installed 0.2.0, replacing 0.1.0 (2026-08-01 02:01 UTC).');
  });

  it('names a rollback as a rollback', () => {
    const text = describeState(
      parseState(
        JSON.stringify({
          finishedAt: '2026-08-01T02:05:00Z',
          fromVersion: '0.1.0',
          toVersion: '0.2.0',
          result: 'rolled-back',
          message: 'did not answer within 60s',
        }),
      ),
    );
    expect(text).toContain('Rolled back to 0.1.0');
    expect(text).toContain('did not answer');
  });

  it('discards an unknown result instead of displaying it', () => {
    expect(parseState('{"result":"probably-fine"}')?.result).toBeNull();
    expect(describeState(parseState('{"result":"probably-fine"}'))).toBeNull();
  });

  it('returns null when nothing has ever run', () => {
    expect(describeState(null)).toBeNull();
    expect(parseState('')).toBeNull();
  });
});

describe('resolveFeed', () => {
  it('is unconfigured by default rather than pointing somewhere that may not exist', () => {
    const source = resolveFeed({});
    expect(source.kind).toBe('none');
    expect(source.location).toBeNull();
  });

  it('prefers a local directory over a URL over a repo', () => {
    const env = { UPDATE_FEED_DIR: '/mnt/usb', UPDATE_FEED_URL: 'https://x/y', UPDATE_REPO: 'a/b' };
    expect(resolveFeed(env)).toMatchObject({ kind: 'dir', location: '/mnt/usb' });
    expect(resolveFeed({ UPDATE_FEED_URL: 'https://x/y', UPDATE_REPO: 'a/b' })).toMatchObject({
      location: 'https://x/y',
    });
    expect(resolveFeed({ UPDATE_REPO: 'a/b' }).location).toContain('api.github.com/repos/a/b');
  });

  it('refuses a URL scheme that is not http(s)', () => {
    // file: would turn a config string into a local-file read by the service process.
    const source = resolveFeed({ UPDATE_FEED_URL: 'file:///etc/passwd' });
    expect(source.kind).toBe('none');
    expect(source.describe).toMatch(/must start with http/i);
  });

  it('refuses a repo that is not owner/name', () => {
    for (const bad of ['owner', 'a/b/c', '../../etc', 'a b/c']) {
      expect(resolveFeed({ UPDATE_REPO: bad }).kind).toBe('none');
    }
  });

  it('ignores blank values rather than treating them as configured', () => {
    expect(resolveFeed({ UPDATE_FEED_DIR: '   ', UPDATE_REPO: '' }).kind).toBe('none');
  });
});

describe('fetchFeed from a directory', () => {
  it('reads a mirror the same way it would read GitHub', async () => {
    // This is the air-gapped USB-stick path, and it is also how the whole mechanism gets
    // exercised with no Pi and nothing published.
    const feed = [
      {
        tag_name: 'v0.2.0',
        published_at: '2026-08-01T00:00:00Z',
        assets: [bundleName('arm64'), CHECKSUM_FILE, SIGNATURE_FILE].map((name) => ({
          name,
          browser_download_url: name,
          size: 40 * 1024 * 1024,
        })),
      },
    ];
    writeFileSync(join(scratch, 'releases.json'), JSON.stringify(feed), 'utf8');

    const result = await fetchFeed(resolveFeed({ UPDATE_FEED_DIR: scratch }));
    expect(result.error).toBeNull();
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0].version).toBe('0.2.0');
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports a missing manifest as a sentence, not an exception', async () => {
    const result = await fetchFeed(resolveFeed({ UPDATE_FEED_DIR: join(scratch, 'nope') }));
    expect(result.releases).toEqual([]);
    expect(result.error).toMatch(/could not read/i);
  });

  it('reports unparseable JSON without throwing', async () => {
    const dir = join(scratch, 'broken');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'releases.json'), '{ truncated', 'utf8');
    const result = await fetchFeed(resolveFeed({ UPDATE_FEED_DIR: dir }));
    expect(result.releases).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('says so when nothing is configured, without pretending it looked', async () => {
    const result = await fetchFeed(resolveFeed({}));
    expect(result.releases).toEqual([]);
    expect(result.error).toMatch(/no update source configured/i);
  });
});
