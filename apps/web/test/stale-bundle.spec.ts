import { describe, expect, it } from 'vitest';
import { isBundleStale } from '../src/shell/stale-bundle';

/*
  Nearly every test here is about NOT firing. A banner that says "a new version is ready"
  when none is, and that a reload does not clear, teaches people to ignore the one message
  that will matter.
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
    /*
      The dev bundle is compiled from the working tree and the API it proxies to is a
      different build almost by definition — developing against the Pi guarantees it. The
      banner would be permanent, and HMR already covers this.
    */
    expect(isBundleStale({ ...base, serverCommit: 'def5678', dev: true })).toBe(false);
  });

  it('stays quiet when the bundle does not know what it is', () => {
    // Built outside a checkout. A build that cannot say what it is must not accuse the
    // server of being different.
    expect(isBundleStale({ ...base, bundleCommit: null, serverCommit: 'def5678' })).toBe(false);
  });

  it('stays quiet when the server does not know what it is', () => {
    // An unstamped API — a dev run, or a build from before version.json existed. Unknown
    // is not "different", and a reload would not change the answer.
    expect(isBundleStale({ ...base, serverCommit: null })).toBe(false);
    expect(isBundleStale({ ...base, serverCommit: undefined })).toBe(false);
  });

  it('treats an empty string as unknown, not as a mismatch', () => {
    // JSON round-trips can turn a missing field into "". Falsy is unknown either way.
    expect(isBundleStale({ ...base, serverCommit: '' })).toBe(false);
    expect(isBundleStale({ ...base, bundleCommit: '' })).toBe(false);
  });
});
