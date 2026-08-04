# Changelog

## 0.1.1 — 2026-08-04

The first public release.

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

- **A new-version prompt.** A browser tab kept running whatever bundle it loaded, so a
  dashboard left open through an overnight update went on showing the old interface with
  no sign anything had changed. The bundle is stamped with its commit and the shell offers
  a reload when the server is serving a different one. A prompt, never an automatic
  reload — updates land on a timer, and a page that reloads itself will do it while
  someone is mid-form.
- **A home location**, in Settings → Vehicle, filled from the car's own position in one
  click. Lets the Car page say the car is parked *at home* rather than just parked.
- **Alerts when a data source goes quiet**, not just when an inverter does. A charger that
  stops answering used to leave its figures frozen on screen with nothing to say so.

### Fixed
- **The Car page said "Parked in the garage" while the car was driving.** That string was
  the else branch of a charger check, never a location, and it had been the unconditional
  answer since the charger stopped answering. It now reports what the car reports.
- **Every TeslaMate timestamp was hours out.** Those columns hold UTC without a zone, so
  they were being read in the host's timezone — three hours in the future on Atlantic
  time, across every drive, charge, update and battery sample.
- **The power tooltip printed `7,005.053684210526`** and labelled watts against an axis in
  kW. Both series now read `7.01 kW`.
- **The mobile tab bar** crowded all five tabs into the left quarter of the screen.
- An update never deletes data — not on install, not on rollback, not on a schema change.
  Asserted by fingerprinting `data/` and `backups/` before and after every scenario.
- `.gitattributes` forces LF on shell scripts and unit files. A fresh clone on Windows
  would previously ship an updater with a CR in its shebang, which Linux reports as
  "not found" for a file that is plainly there.

### Notes
Licensed AGPL-3.0-or-later. Shipped briefly as Apache-2.0 by mistake and corrected before
any outside contributor existed, which is the only cheap moment to change a licence.

Verify the download before installing it — an unsigned build is one the updater will
refuse anyway:

```bash
minisign -Vm SHA256SUMS -P <public key>
sha256sum -c SHA256SUMS --ignore-missing
```
