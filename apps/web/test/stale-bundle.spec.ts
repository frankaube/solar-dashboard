import { describe, expect, it } from 'vitest';
import { isBundleStale } from '../src/shell/stale-bundle';

/*
  Nearly every test here is about NOT firing: a "new version is ready" banner that a reload
  does not clear trains people to ignore it.
*/

const base = { bundleCommit: 'abc1234', serverCommit: 'abc1234', dev: false };

describe('isBundleStale', () => {
  it('fires when the server is running different code', () => {
    expect(isBundleStale({ ...base, serverCommit: 'def5678' })).toBe(true);
  });

  it('stays quiet when they match', () => {
    expect(isBundleStale(base)).toBe(false);
  });

  it('stays quiet in development', () => {
    // The dev bundle is compiled from the working tree and the API it proxies to is a
    // different build by definition, so the banner would be permanent. HMR covers this.
    expect(isBundleStale({ ...base, serverCommit: 'def5678', dev: true })).toBe(false);
  });

  it('stays quiet when the bundle does not know what it is', () => {
    // Built outside a checkout; a build that cannot say what it is must not accuse the server.
    expect(isBundleStale({ ...base, bundleCommit: null, serverCommit: 'def5678' })).toBe(false);
  });

  it('stays quiet when the server does not know what it is', () => {
    // An unstamped API — a dev run, or a build from before version.json existed. Unknown is
    // not "different".
    expect(isBundleStale({ ...base, serverCommit: null })).toBe(false);
    expect(isBundleStale({ ...base, serverCommit: undefined })).toBe(false);
  });

  it('treats an empty string as unknown, not as a mismatch', () => {
    // JSON round-trips can turn a missing field into "". Falsy is unknown either way.
    expect(isBundleStale({ ...base, serverCommit: '' })).toBe(false);
    expect(isBundleStale({ ...base, bundleCommit: '' })).toBe(false);
  });
});
