import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Release, parseReleases } from './releases';

/**
 * Three forms, in precedence order, all producing the same GitHub-shaped JSON:
 *
 *   UPDATE_FEED_DIR=/mnt/usb/releases      a directory holding releases.json + assets
 *   UPDATE_FEED_URL=https://.../releases   any URL serving that JSON
 *   UPDATE_REPO=owner/name                 shorthand for the GitHub Releases API
 *
 * The directory form is how an air-gapped install updates from a USB stick, through the same
 * parser and signature check. Nothing is configured by default: a hardcoded repo that 404s
 * is indistinguishable from "no updates available".
 */

export interface FeedSource {
  kind: 'dir' | 'url' | 'none';
  /** Directory path or absolute URL. Null when nothing is configured. */
  location: string | null;
  describe: string;
}

export const FEED_MANIFEST = 'releases.json';

/** GitHub's cap is 100; 20 is enough history. */
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
      http is allowed for a LAN mirror: authenticity comes from the minisign signature over
      the checksums, not the transport. Other schemes would turn a config string into a
      local-file read by a service process.
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

/** Slow enough for a Pi on domestic broadband. */
const TIMEOUT_MS = 15_000;
/** A release feed is tens of kilobytes. Anything near this is not a feed. */
const MAX_BYTES = 2 * 1024 * 1024;

async function readCapped(response: Response): Promise<string> {
  // Checked before reading, so an endless response costs a header round-trip, not memory.
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
          // Identity-free: no install id, no version, no query parameters.
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
