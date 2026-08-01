# Changelog

## Unreleased

### Added
- **Automatic updates from a signed release feed.** Settings → Updates: a channel, a
  switch for unattended installs, and an hour for when they may run. Off by default, and
  off means no outbound request at all.
- A root-owned systemd timer does the installing, not the web app. The app checks the
  feed and may write a file naming a version; that file carries a version and nothing
  else, and the updater resolves the feed from its own root-owned config.
- Builds accepted only on a minisign signature over `SHA256SUMS`. No key configured means
  nothing installs.
- Health-gated installs: the new build must answer `/api/status` reporting the commit that
  was just installed, or the previous one is restored automatically.
- Build stamping. `/api/status` reports the version, commit and build time; an unstamped
  build says so rather than inventing a number.
- `scripts/deploy-pi.sh --rollback`, and a verified deploy that exits non-zero if the Pi
  is not running what was just built.
- CI, and a release workflow that drafts a release and installs its own artifact first.

### Fixed
- An update never deletes data — not on install, not on rollback, not on a schema change.
  Asserted by fingerprinting `data/` and `backups/` before and after every scenario.
- `.gitattributes` forces LF on shell scripts and unit files. A fresh clone on Windows
  would previously ship an updater with a CR in its shebang, which Linux reports as
  "not found" for a file that is plainly there.

### Notes
This project has no released versions yet; `0.1.0` will be the first.
