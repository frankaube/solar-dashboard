import { BuildInfo } from '../common/build-info';
import { Version, compareVersions, isPrereleaseVersion, parseVersion } from './semver';

/**
 * Reading a release feed and deciding whether to act on it.
 *
 * Pure, and separate from anything that fetches or installs, because every interesting
 * case here is a refusal — an unstamped build, a downgrade, a release with no asset for
 * this architecture, an unsigned one. Those are the cases that have to be right, they are
 * the ones nobody will ever see happen, and they are only checkable if the decision can
 * be called with an arbitrary feed and an arbitrary current build.
 *
 * The feed format is the GitHub Releases API response, and a self-hosted mirror is a
 * saved copy of that JSON. One parser, and pointing the updater at a local directory
 * exercises the same code path GitHub will — which is how any of this gets tested without
 * publishing anything.
 */

export type Channel = 'off' | 'stable' | 'prerelease';

export const CHANNELS: Array<{ id: Channel; label: string; detail: string }> = [
  { id: 'off', label: 'Off', detail: 'Never check. Nothing leaves this machine.' },
  { id: 'stable', label: 'Stable', detail: 'Released versions only.' },
  { id: 'prerelease', label: 'Pre-release', detail: 'Includes betas. Expect rough edges.' },
];

export const DEFAULT_CHANNEL: Channel = 'off';

export function isChannel(value: unknown): value is Channel {
  return value === 'off' || value === 'stable' || value === 'prerelease';
}

export interface ReleaseAsset {
  name: string;
  url: string;
  sizeBytes: number | null;
}

export interface Release {
  version: string;
  parsed: Version;
  tag: string;
  prerelease: boolean;
  publishedAt: string | null;
  notesUrl: string | null;
  notes: string | null;
  assets: ReleaseAsset[];
}

/** Long enough to see what changed, short enough not to paste a changelog into a panel. */
const NOTES_LIMIT = 2000;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseAsset(raw: unknown): ReleaseAsset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const asset = raw as Record<string, unknown>;
  const name = asString(asset.name);
  const url = asString(asset.browser_download_url) ?? asString(asset.url);
  if (!name || !url) return null;
  const size = typeof asset.size === 'number' && Number.isFinite(asset.size) ? asset.size : null;
  return { name, url, sizeBytes: size };
}

/**
 * Parse a feed, discarding anything unusable rather than throwing.
 *
 * A feed with one malformed entry must still offer the others: this runs unattended, and
 * "the update check crashed" is a failure mode that would go unnoticed for months.
 */
export function parseReleases(raw: unknown): Release[] {
  const list = Array.isArray(raw) ? raw : null;
  if (!list) return [];
  const releases: Release[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const release = entry as Record<string, unknown>;
    // Drafts are visible to the account that owns them via an authenticated call. They are
    // by definition not published, so they are never update candidates.
    if (release.draft === true) continue;
    const tag = asString(release.tag_name) ?? asString(release.name);
    const parsed = parseVersion(tag);
    if (!parsed) continue;
    const notes = asString(release.body);
    releases.push({
      version: parsed.raw,
      parsed,
      tag: tag as string,
      // A version tagged -rc.1 is a prerelease whether or not the flag was ticked. Trusting
      // only the flag lets a mis-published release reach the stable channel.
      prerelease: release.prerelease === true || isPrereleaseVersion(parsed),
      publishedAt: asString(release.published_at),
      notesUrl: asString(release.html_url),
      notes: notes ? notes.slice(0, NOTES_LIMIT) : null,
      assets: Array.isArray(release.assets)
        ? release.assets.map(parseAsset).filter((asset): asset is ReleaseAsset => asset !== null)
        : [],
    });
  }
  return releases.sort((a, b) => compareVersions(b.parsed, a.parsed));
}

/** What the bundle for a machine is called, and the two files that authenticate it. */
export function bundleName(arch: string): string {
  return `solar-dashboard-${arch}.tar.gz`;
}
export const CHECKSUM_FILE = 'SHA256SUMS';
export const SIGNATURE_FILE = 'SHA256SUMS.minisig';

/** node's arch names are the ones used in the asset names, so no mapping table. */
export function currentArch(): string {
  return process.arch;
}

export interface UpdateAssets {
  bundle: ReleaseAsset;
  checksums: ReleaseAsset;
  signature: ReleaseAsset;
}

export function findAssets(release: Release, arch: string): UpdateAssets | null {
  const want = bundleName(arch);
  const bundle = release.assets.find((asset) => asset.name === want);
  const checksums = release.assets.find((asset) => asset.name === CHECKSUM_FILE);
  const signature = release.assets.find((asset) => asset.name === SIGNATURE_FILE);
  if (!bundle || !checksums || !signature) return null;
  return { bundle, checksums, signature };
}

export interface UpdateDecision {
  /** The release to install, or null when there is nothing to do. */
  release: Release | null;
  assets: UpdateAssets | null;
  /** Why, in a sentence, for the panel and the log. Always set. */
  reason: string;
  /**
   * True when a newer release exists but cannot be installed — a missing asset, an
   * unsigned release, an unstamped current build. Distinct from "up to date", because one
   * of them is fine and the other needs a human.
   */
  blocked: boolean;
}

export function chooseUpdate({
  current,
  releases,
  channel,
  arch = currentArch(),
  platform = process.platform,
}: {
  current: BuildInfo;
  releases: Release[];
  channel: Channel;
  arch?: string;
  /** Injectable so the refusal below can be tested from any machine. */
  platform?: string;
}): UpdateDecision {
  const nothing = (reason: string, blocked = false): UpdateDecision => ({
    release: null,
    assets: null,
    reason,
    blocked,
  });

  if (channel === 'off') return nothing('Update checks are off.');

  /*
    Self-updating is Linux-only, and Windows is told so rather than left to discover it.

    The whole mechanism assumes a root-owned systemd timer that can write /opt and call
    systemctl — see handoff.ts for why that separation exists. None of it has a Windows
    equivalent, and the asset naming would go wrong first anyway: node reports 'x64' on
    both, so a Windows install would resolve `solar-dashboard-x64.tar.gz` — the LINUX
    bundle — download it, verify its signature happily, and unpack ELF binaries over a
    working install.

    So this refuses before any of that, and says where upgrades actually come from. Blocked
    rather than merely negative: there is nothing to retry, and the UI treats the two
    differently.
  */
  if (platform !== 'linux') {
    return nothing(
      'In-app updates are Linux only. On Windows, download the latest installer from the releases page and run it — it upgrades in place and keeps your data.',
      true,
    );
  }

  /*
    An unstamped build is never replaced automatically.

    This is the rule that keeps the feature from eating your own work. A build made
    locally, or one predating the version stamp, cannot be compared to anything — so
    "is the release newer" has no answer, and installing anyway would be a coin flip
    between an upgrade and silently discarding whatever is running.
  */
  if (!current.stamped) {
    return nothing(
      'This build has no version stamp, so there is nothing to compare a release against. Updates stay manual.',
      true,
    );
  }

  const running = parseVersion(current.version);
  if (!running) {
    return nothing(`Cannot read the running version ("${current.version}").`, true);
  }

  const candidates = releases.filter((release) =>
    channel === 'stable' ? !release.prerelease : true,
  );
  if (candidates.length === 0) return nothing('No releases published on this channel yet.');

  const newest = candidates[0];
  const order = compareVersions(newest.parsed, running);
  if (order === 0) return nothing(`Up to date on ${running.raw}.`);
  if (order < 0) {
    /*
      Running something newer than the feed offers. Never treated as an update — that is
      how an auto-updater turns into an auto-downgrader, and the most likely cause is
      benign: a local build, or a release that was pulled.
    */
    return nothing(`Running ${running.raw}, which is newer than the published ${newest.version}.`);
  }

  const assets = findAssets(newest, arch);
  if (!assets) {
    return nothing(
      `${newest.version} is available but has no ${bundleName(arch)} with ${CHECKSUM_FILE} and ${SIGNATURE_FILE} attached. Not installing an unverifiable build.`,
      true,
    );
  }

  return {
    release: newest,
    assets,
    reason: `${newest.version} is available.`,
    blocked: false,
  };
}
