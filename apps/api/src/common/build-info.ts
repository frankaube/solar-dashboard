import { existsSync, readFileSync } from 'node:fs';
import { resourcePath } from './lite';

/**
 * Which build is actually running.
 *
 * This exists because there was no way to answer that question, and it is the question
 * every deploy raises. `process.env.npm_package_version` is only set by a package-manager
 * script — a packaged binary started by systemd never has it, so the app reported version
 * "0.1.0" forever regardless of what was installed. Push an update, get a success message,
 * and have no evidence the new code is running.
 *
 * That is the same failure as grepping a pkg binary for a string to check freshness: the
 * check answers a different question than the one being asked. The build now stamps a
 * version.json next to the binary, this reads it, and the deploy script compares what it
 * built against what the machine reports before calling the update done.
 */

export interface BuildInfo {
  version: string;
  /** Short git SHA at build time, or null when built outside a checkout. */
  commit: string | null;
  builtAt: string | null;
  /** False when no stamp was found — a dev run, or a bundle built before this existed. */
  stamped: boolean;
}

/**
 * No stamp, or an unreadable one. Reported as such rather than substituted with a
 * plausible number — an invented version is worse than an absent one, because it will be
 * trusted. A corrupt stamp must also not stop the app booting.
 */
export function unstampedBuild(): BuildInfo {
  return {
    version: process.env.npm_package_version ?? 'dev',
    commit: null,
    builtAt: null,
    stamped: false,
  };
}

/** Parse a version.json body. Returns null when it is not usable, so the caller falls back. */
export function parseStamp(body: string): BuildInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  // Array.isArray is not pedantry: typeof [] is 'object', so a stamp that is somehow a
  // JSON array would otherwise be reported as stamped with version "unknown" — claiming a
  // stamp was read when nothing usable was.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const stamp = raw as Partial<Record<keyof BuildInfo, unknown>>;
  return {
    version: typeof stamp.version === 'string' ? stamp.version : 'unknown',
    commit: typeof stamp.commit === 'string' && stamp.commit ? stamp.commit : null,
    builtAt: typeof stamp.builtAt === 'string' && stamp.builtAt ? stamp.builtAt : null,
    stamped: true,
  };
}

/** "0.4.1 (a1b2c3d)", or an honest "dev" — never a plausible-looking invented number. */
export function describeBuild(info: BuildInfo = buildInfo()): string {
  return info.commit ? `${info.version} (${info.commit})` : info.version;
}

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const stampPath = resourcePath('version.json');
  if (existsSync(stampPath)) {
    let body: string | null = null;
    try {
      body = readFileSync(stampPath, 'utf8');
    } catch {
      body = null;
    }
    const parsed = body === null ? null : parseStamp(body);
    if (parsed) {
      cached = parsed;
      return cached;
    }
  }
  cached = unstampedBuild();
  return cached;
}
