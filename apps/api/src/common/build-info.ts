import { existsSync, readFileSync } from 'node:fs';
import { resourcePath } from './lite';

/**
 * `process.env.npm_package_version` is only set by a package-manager script, so a packaged
 * binary started by systemd never has it. The build stamps a version.json beside the binary.
 */

export interface BuildInfo {
  version: string;
  /** Short git SHA at build time, or null when built outside a checkout. */
  commit: string | null;
  builtAt: string | null;
  /** False when no stamp was found — a dev run, or a bundle built before this existed. */
  stamped: boolean;
}

/** No stamp, or an unreadable one. A corrupt stamp must not stop the app booting. */
export function unstampedBuild(): BuildInfo {
  return {
    version: process.env.npm_package_version ?? 'dev',
    commit: null,
    builtAt: null,
    stamped: false,
  };
}

/** Parse a version.json body. Null when it is not usable. */
export function parseStamp(body: string): BuildInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  // typeof [] is 'object', so an array would otherwise read as stamped/"unknown".
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const stamp = raw as Partial<Record<keyof BuildInfo, unknown>>;
  return {
    version: typeof stamp.version === 'string' ? stamp.version : 'unknown',
    commit: typeof stamp.commit === 'string' && stamp.commit ? stamp.commit : null,
    builtAt: typeof stamp.builtAt === 'string' && stamp.builtAt ? stamp.builtAt : null,
    stamped: true,
  };
}

/** "0.4.1 (a1b2c3d)", or "dev" — never an invented number. */
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
