import { describe, expect, it } from 'vitest';
import { compareVersions, isPrereleaseVersion, parseVersion } from '../src/updates/semver';
import {
  CHECKSUM_FILE,
  SIGNATURE_FILE,
  bundleName,
  chooseUpdate,
  findAssets,
  parseReleases,
} from '../src/updates/releases';
import { BuildInfo } from '../src/common/build-info';

const stamped = (version: string, commit = 'cf8067e'): BuildInfo => ({
  version,
  commit,
  builtAt: '2026-07-30T12:03:27.616Z',
  stamped: true,
});

const asset = (name: string) => ({
  name,
  browser_download_url: `https://example.invalid/${name}`,
  size: 1024,
});

const fullRelease = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  published_at: '2026-08-01T00:00:00Z',
  html_url: `https://example.invalid/releases/${tag}`,
  body: 'what changed',
  assets: [asset(bundleName('arm64')), asset(CHECKSUM_FILE), asset(SIGNATURE_FILE)],
  ...extra,
});

describe('parseVersion / compareVersions', () => {
  it('accepts a git tag with or without the v', () => {
    expect(parseVersion('v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, raw: '1.2.3' });
    expect(parseVersion('1.2.3')).toMatchObject({ raw: '1.2.3' });
  });

  it('rejects things that are not versions', () => {
    for (const bad of ['dev', '', 'v1.2', '1.2.3.4', 'latest', null, undefined, '  ']) {
      expect(parseVersion(bad as string)).toBeNull();
    }
  });

  it('orders by the numbers, not by string length', () => {
    // '0.10.0' < '0.9.0' as strings. This is the comparison that decides whether a machine
    // downloads a binary, so getting it backwards means never updating past 0.9.
    const older = parseVersion('0.9.0')!;
    const newer = parseVersion('0.10.0')!;
    expect(compareVersions(newer, older)).toBe(1);
    expect(compareVersions(older, newer)).toBe(-1);
    expect(compareVersions(older, parseVersion('0.9.0')!)).toBe(0);
  });

  it('ranks a prerelease below the release it leads to', () => {
    expect(compareVersions(parseVersion('1.0.0')!, parseVersion('1.0.0-rc.1')!)).toBe(1);
    expect(compareVersions(parseVersion('1.0.0-rc.1')!, parseVersion('0.9.9')!)).toBe(1);
  });

  it('compares numeric prerelease identifiers as numbers', () => {
    // beta.10 > beta.2, which string comparison gets wrong.
    expect(compareVersions(parseVersion('1.0.0-beta.10')!, parseVersion('1.0.0-beta.2')!)).toBe(1);
  });

  it('ranks fewer identifiers first and numeric below alphanumeric', () => {
    expect(compareVersions(parseVersion('1.0.0-rc.1')!, parseVersion('1.0.0-rc.1.1')!)).toBe(-1);
    expect(compareVersions(parseVersion('1.0.0-alpha')!, parseVersion('1.0.0-1')!)).toBe(1);
  });

  it('ignores build metadata', () => {
    expect(compareVersions(parseVersion('1.0.0+abc')!, parseVersion('1.0.0+def')!)).toBe(0);
  });

  it('knows a prerelease when it sees one', () => {
    expect(isPrereleaseVersion(parseVersion('1.0.0-rc.1')!)).toBe(true);
    expect(isPrereleaseVersion(parseVersion('1.0.0')!)).toBe(false);
  });
});

describe('parseReleases', () => {
  it('reads the GitHub shape, newest first', () => {
    const releases = parseReleases([fullRelease('v0.1.0'), fullRelease('v0.3.0'), fullRelease('v0.2.0')]);
    expect(releases.map((r) => r.version)).toEqual(['0.3.0', '0.2.0', '0.1.0']);
    expect(releases[0]).toMatchObject({ tag: 'v0.3.0', prerelease: false, notes: 'what changed' });
  });

  it('drops drafts and unparseable tags without throwing', () => {
    const releases = parseReleases([
      fullRelease('v0.4.0', { draft: true }),
      fullRelease('nightly'),
      fullRelease('v0.2.0'),
      'not an object',
      null,
    ]);
    expect(releases.map((r) => r.version)).toEqual(['0.2.0']);
  });

  it('survives a feed that is not a list', () => {
    for (const bad of [null, {}, 'x', 42]) expect(parseReleases(bad)).toEqual([]);
  });

  it('treats a -rc tag as a prerelease even when the flag says otherwise', () => {
    // A mis-published release must not reach the stable channel on the strength of a
    // checkbox someone forgot to tick.
    const [release] = parseReleases([fullRelease('v1.0.0-rc.1', { prerelease: false })]);
    expect(release.prerelease).toBe(true);
  });

  it('keeps assets it can address and discards ones it cannot', () => {
    const [release] = parseReleases([
      fullRelease('v0.2.0', {
        assets: [asset('good.tar.gz'), { name: 'no-url.tar.gz' }, { browser_download_url: 'x' }, 7],
      }),
    ]);
    expect(release.assets.map((a) => a.name)).toEqual(['good.tar.gz']);
  });
});

describe('findAssets', () => {
  it('requires the bundle, the checksums and the signature', () => {
    const [complete] = parseReleases([fullRelease('v0.2.0')]);
    expect(findAssets(complete, 'arm64')).not.toBeNull();

    const [unsigned] = parseReleases([
      fullRelease('v0.2.0', { assets: [asset(bundleName('arm64')), asset(CHECKSUM_FILE)] }),
    ]);
    expect(findAssets(unsigned, 'arm64')).toBeNull();
  });

  it('does not hand an arm64 machine an x64 bundle', () => {
    const [release] = parseReleases([fullRelease('v0.2.0')]);
    expect(findAssets(release, 'x64')).toBeNull();
    expect(findAssets(release, 'arm64')).not.toBeNull();
  });
});

describe('chooseUpdate', () => {
  const releases = parseReleases([fullRelease('v0.2.0'), fullRelease('v0.3.0-rc.1')]);

  it('offers the newest stable release on the stable channel', () => {
    const decision = chooseUpdate({
      current: stamped('0.1.0'),
      releases,
      channel: 'stable', platform: 'linux',
      arch: 'arm64',
    });
    expect(decision.release?.version).toBe('0.2.0');
    expect(decision.assets?.bundle.name).toBe('solar-dashboard-arm64.tar.gz');
    expect(decision.blocked).toBe(false);
  });

  it('offers the release candidate only on the prerelease channel', () => {
    expect(
      chooseUpdate({ current: stamped('0.1.0'), releases, channel: 'prerelease', platform: 'linux', arch: 'arm64' })
        .release?.version,
    ).toBe('0.3.0-rc.1');
  });

  it('does nothing at all when the channel is off', () => {
    const decision = chooseUpdate({
      current: stamped('0.1.0'),
      releases,
      channel: 'off', platform: 'linux',
      arch: 'arm64',
    });
    expect(decision.release).toBeNull();
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toMatch(/off/i);
  });

  it('refuses to touch an unstamped build', () => {
    // The promised rule: if we cannot tell what is running, we cannot tell whether we would
    // be replacing it with something older.
    const decision = chooseUpdate({
      current: { version: 'dev', commit: null, builtAt: null, stamped: false },
      releases,
      channel: 'stable',
      arch: 'arm64',
      platform: 'linux',
    });
    expect(decision.release).toBeNull();
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/no version stamp/i);
  });

  it('is a no-op when the newest release is what is already running', () => {
    const decision = chooseUpdate({
      current: stamped('0.2.0'),
      releases,
      channel: 'stable', platform: 'linux',
      arch: 'arm64',
    });
    expect(decision.release).toBeNull();
    expect(decision.reason).toMatch(/up to date/i);
  });

  it('never downgrades', () => {
    // Running ahead of the feed — a local build, or a release that was pulled. Both are
    // reasons to leave the machine alone, not to roll it back.
    const decision = chooseUpdate({
      current: stamped('0.9.0'),
      releases,
      channel: 'stable', platform: 'linux',
      arch: 'arm64',
    });
    expect(decision.release).toBeNull();
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toMatch(/newer than the published/i);
  });

  it('blocks, loudly, on a release with no signature', () => {
    const unsigned = parseReleases([
      fullRelease('v0.2.0', { assets: [asset(bundleName('arm64')), asset(CHECKSUM_FILE)] }),
    ]);
    const decision = chooseUpdate({
      current: stamped('0.1.0'),
      releases: unsigned,
      channel: 'stable', platform: 'linux',
      arch: 'arm64',
    });
    expect(decision.release).toBeNull();
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/unverifiable/i);
  });

  it('blocks when a version cannot be parsed rather than guessing', () => {
    const decision = chooseUpdate({
      current: { ...stamped('0.1.0'), version: 'main' },
      releases,
      channel: 'stable',
      arch: 'arm64',
      platform: 'linux',
    });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/cannot read the running version/i);
  });

  it('says so plainly when the feed is empty', () => {
    const decision = chooseUpdate({
      current: stamped('0.1.0'),
      releases: [],
      channel: 'stable', platform: 'linux',
      arch: 'arm64',
    });
    expect(decision.release).toBeNull();
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toMatch(/no releases/i);
  });

  it('does not offer a prerelease to a stable channel even when it is the only release', () => {
    const decision = chooseUpdate({
      current: stamped('0.1.0'),
      releases: parseReleases([fullRelease('v0.3.0-rc.1')]),
      channel: 'stable', platform: 'linux',
      arch: 'arm64',
    });
    expect(decision.release).toBeNull();
  });
});

describe('platforms that cannot update themselves', () => {
  // Same feed the block above uses: one stable release, one candidate.
  const releases = parseReleases([fullRelease('v0.2.0'), fullRelease('v0.3.0-rc.1')]);

  /*
    The trap this refusal exists for, and it is not merely "unsupported".

    node reports arch 'x64' on Windows and on Linux alike, so `bundleName` resolves to
    `solar-dashboard-x64.tar.gz` on both — the LINUX bundle. Without this gate a Windows
    install would find that asset, verify its signature perfectly happily, and unpack ELF
    binaries over a working installation. The signature check cannot catch it: the bundle
    is genuine, it is just for the wrong operating system.
  */
  it('refuses on Windows, and says where upgrades actually come from', () => {
    const decision = chooseUpdate({
      current: stamped('0.1.0'),
      releases,
      channel: 'stable',
      arch: 'x64',
      platform: 'win32',
    });
    expect(decision.release).toBeNull();
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/installer/i);
  });

  it('refuses on macOS too, rather than listing every platform it does support', () => {
    const decision = chooseUpdate({
      current: stamped('0.1.0'),
      releases,
      channel: 'stable',
      arch: 'arm64',
      platform: 'darwin',
    });
    expect(decision.blocked).toBe(true);
  });

  it('still lets "off" mean no traffic, before any platform question', () => {
    // Off has to mean off everywhere; a refusal that mentions installers on a machine
    // that asked for silence is still noise.
    const decision = chooseUpdate({
      current: stamped('0.1.0'),
      releases,
      channel: 'off',
      platform: 'win32',
    });
    expect(decision.reason).toMatch(/off/i);
    expect(decision.blocked).toBe(false);
  });

  it('leaves Linux exactly as it was', () => {
    const decision = chooseUpdate({
      current: stamped('0.1.0'),
      releases,
      channel: 'stable',
      arch: 'arm64',
      platform: 'linux',
    });
    expect(decision.release?.version).toBe('0.2.0');
  });
});
