import { describe, expect, it } from 'vitest';
import { describeBuild, parseStamp, unstampedBuild } from '../src/common/build-info';

/**
 * The deploy script decides whether an update worked by comparing the commit it built
 * against the commit the running app reports. That makes this file the thing every Pi
 * update trusts, so the failure modes are pinned down here rather than discovered during
 * an update that has already replaced the working binary.
 */
describe('parseStamp', () => {
  it('reads a stamp the build writes', () => {
    const stamp = parseStamp(
      '{"version":"0.1.0","commit":"cf8067e","builtAt":"2026-07-30T12:03:27.616Z"}',
    );
    expect(stamp).toEqual({
      version: '0.1.0',
      commit: 'cf8067e',
      builtAt: '2026-07-30T12:03:27.616Z',
      stamped: true,
    });
  });

  it('returns null on a truncated stamp rather than throwing', () => {
    // A copy interrupted mid-write. The app has to boot anyway.
    expect(parseStamp('{"version":"0.1.0","com')).toBeNull();
    expect(parseStamp('')).toBeNull();
  });

  it('returns null when the file is not an object', () => {
    expect(parseStamp('null')).toBeNull();
    expect(parseStamp('"0.1.0"')).toBeNull();
    expect(parseStamp('[1,2]')).toBeNull();
  });

  it('treats a stamp built outside a checkout as stamped, with no commit', () => {
    // A release tarball unpacked without .git — a real version, genuinely no SHA.
    const stamp = parseStamp('{"version":"0.1.0","commit":null,"builtAt":"2026-07-30T12:00:00Z"}');
    expect(stamp).toMatchObject({ version: '0.1.0', commit: null, stamped: true });
  });

  it('rejects an empty-string commit instead of reporting it as one', () => {
    // git rev-parse failing produces "" — which would otherwise compare equal to another
    // failed build and pass the deploy check while proving nothing.
    expect(parseStamp('{"version":"0.1.0","commit":"","builtAt":""}')).toMatchObject({
      commit: null,
      builtAt: null,
    });
  });

  it('does not invent a version when the field is missing or the wrong type', () => {
    expect(parseStamp('{"commit":"cf8067e"}')).toMatchObject({ version: 'unknown' });
    expect(parseStamp('{"version":42}')).toMatchObject({ version: 'unknown' });
  });
});

describe('unstampedBuild', () => {
  it('says so rather than guessing', () => {
    const info = unstampedBuild();
    expect(info.stamped).toBe(false);
    expect(info.commit).toBeNull();
    expect(info.builtAt).toBeNull();
  });
});

describe('describeBuild', () => {
  it('names the commit when there is one', () => {
    expect(
      describeBuild({ version: '0.1.0', commit: 'cf8067e', builtAt: null, stamped: true }),
    ).toBe('0.1.0 (cf8067e)');
  });

  it('omits empty parentheses when there is not', () => {
    expect(describeBuild({ version: 'dev', commit: null, builtAt: null, stamped: false })).toBe(
      'dev',
    );
  });
});
