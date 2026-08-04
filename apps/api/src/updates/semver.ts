/**
 * Just enough semver to decide whether a release is newer than what is running.
 *
 * Hand-rolled rather than pulled in, for one reason: this comparison decides whether a
 * machine downloads and executes a new binary unattended. A wrong answer either installs
 * a downgrade or silently stops updating, and both are quiet failures. Twenty lines that
 * can be read in full beat a dependency whose prerelease semantics have to be trusted.
 *
 * The prerelease rules are the ones people get wrong, so they are spelled out:
 * 1.0.0-beta.2 < 1.0.0-beta.10 (numeric identifiers compare as numbers, not strings) and
 * 1.0.0-rc.1 < 1.0.0 (a prerelease is always older than the release it leads to).
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, empty for a final release. */
  pre: Array<string | number>;
  raw: string;
}

/** Accepts an optional leading v, so a git tag can be passed straight in. */
const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string | null | undefined): Version | null {
  if (typeof text !== 'string') return null;
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    pre: pre
      ? pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
      : [],
    raw: text.trim().replace(/^v/, ''),
  };
}

function comparePre(a: Array<string | number>, b: Array<string | number>): number {
  // A release outranks any prerelease of the same numbers — and 1.0.0 vs 1.0.0-rc.1 is
  // exactly the comparison an updater makes the day a release ships.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i];
    const right = b[i];
    // Fewer identifiers wins when everything before matched: rc.1 < rc.1.1.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = typeof left === 'number';
    const rightNumeric = typeof right === 'number';
    if (leftNumeric && rightNumeric) return left < right ? -1 : 1;
    // Numeric identifiers always rank below alphanumeric ones.
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return String(left) < String(right) ? -1 : 1;
  }
  return 0;
}

/** -1 if a is older, 0 if equal, 1 if a is newer. Build metadata is ignored, per spec. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePre(a.pre, b.pre);
}

export function isPrereleaseVersion(version: Version): boolean {
  return version.pre.length > 0;
}
