import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Release, parseReleases } from './releases';

/**
 * Where the release feed comes from, and reading it.
 *
 * Three forms, in precedence order, all of which produce the same GitHub-shaped JSON:
 *
 *   UPDATE_FEED_DIR=/mnt/usb/releases      a directory holding releases.json + assets
 *   UPDATE_FEED_URL=https://.../releases   any URL serving that JSON
 *   UPDATE_REPO=owner/name                 shorthand for the GitHub Releases API
 *
 * The directory form is not a test seam bolted on afterwards — it is how an air-gapped
 * install updates from a USB stick, and it means the whole path can be exercised without
 * publishing anything or having a Pi. Same parser, same decision code, same signature
 * check.
 *
 * Nothing is configured by default. An unconfigured install says so rather than pointing
 * at a repository that may not exist, because a hardcoded default that 404s looks
 * identical to "no updates available" — and would be the wrong kind of wrong.
 */

export interface FeedSource {
  kind: 'dir' | 'url' | 'none';
  /** Directory path or absolute URL. Null when nothing is configured. */
  location: string | null;
  /** What to show in the UI: names the mechanism, not the internals. */
  describe: string;
}

export const FEED_MANIFEST = 'releases.json';

/** GitHub's own cap is 100; 20 is plenty of history to find the newest of anything. */
const GITHUB_PAGE_SIZE = 20;

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function resolveFeed(env: NodeJS.ProcessEnv = process.env): FeedSource {
  const dir = env.UPDATE_FEED_DIR?.trim();
  if (dir) {
    return { kind: 'dir', location: dir, describe: `a local directory (${dir})` };
  }

  const url = env.UPDATE_FEED_URL?.trim();
  if (url) {
    /*
      http is allowed for a LAN mirror, and that is not an oversight. Authenticity here
      comes from the minisign signature over the checksums, verified by the updater against
      a key it holds — not from the transport. TLS on the metadata fetch would protect
      privacy, which is worth having, but it is not what stops a bad binary.

      Other schemes are refused outright: file: and friends would turn a config string into
      a local-file read by a service process, which is a different feature with different
      risks. That is what UPDATE_FEED_DIR is for.
    */
    if (!/^https?:\/\//i.test(url)) {
      return {
        kind: 'none',
        location: null,
        describe: `UPDATE_FEED_URL must start with http:// or https:// (got "${url}")`,
      };
    }
    return { kind: 'url', location: url, describe: url };
  }

  const repo = env.UPDATE_REPO?.trim();
  if (repo) {
    if (!REPO_PATTERN.test(repo)) {
      return {
        kind: 'none',
        location: null,
        describe: `UPDATE_REPO must look like owner/name (got "${repo}")`,
      };
    }
    return {
      kind: 'url',
      location: `https://api.github.com/repos/${repo}/releases?per_page=${GITHUB_PAGE_SIZE}`,
      describe: `GitHub releases for ${repo}`,
    };
  }

  return { kind: 'none', location: null, describe: 'No update source configured.' };
}

/** Slow enough for a Pi on domestic broadband, short enough not to hold a request open. */
const TIMEOUT_MS = 15_000;
/** A release feed is tens of kilobytes. Anything near this is not a feed. */
const MAX_BYTES = 2 * 1024 * 1024;

async function readCapped(response: Response): Promise<string> {
  // Length is checked before reading rather than after, so an oversized or endless
  // response costs one header round-trip instead of filling memory on a Pi.
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`feed is ${declared} bytes, which is not a release feed`);
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw new Error('feed is too large to be a release feed');
  return body;
}

export interface FeedResult {
  releases: Release[];
  /** Null on success; a sentence on failure. Never thrown — this runs unattended. */
  error: string | null;
}

export async function fetchFeed(
  source: FeedSource,
  now = new Date(),
): Promise<FeedResult & { checkedAt: string }> {
  const checkedAt = now.toISOString();
  if (source.kind === 'none' || !source.location) {
    return { releases: [], error: source.describe, checkedAt };
  }

  try {
    let body: string;
    if (source.kind === 'dir') {
      body = await readFile(join(source.location, FEED_MANIFEST), 'utf8');
    } else {
      const response = await fetch(source.location, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // Deliberately identity-free: no install id, no version, no query parameters. The
          // request still reveals an IP and that this install exists, which is why the
          // default channel is off — but it carries nothing beyond that.
          'user-agent': 'solar-dashboard',
          accept: 'application/vnd.github+json',
        },
      });
      if (!response.ok) {
        return {
          releases: [],
          error: `${source.describe} returned HTTP ${response.status}`,
          checkedAt,
        };
      }
      body = await readCapped(response);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return { releases: [], error: `${source.describe} did not return JSON`, checkedAt };
    }
    return { releases: parseReleases(raw), error: null, checkedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { releases: [], error: `could not read ${source.describe}: ${message}`, checkedAt };
  }
}
