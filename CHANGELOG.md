# Changelog

## 0.1.2 — 2026-08-04

### Added
- **Self-consumption measured at the mains, instead of typed in.** Mark a meter as clamped
  on the service entrance (Devices → the meter → "this is the main service") and what the
  house used directly becomes production minus what actually left the property. No
  appliance has to be identified or metered; the boundary is measured instead of the
  contents. Until then the owner's estimated share still applies, and every figure derived
  from it still says so.

  Only for periods the clamp fully covers. A meter fitted in March has nothing to say about
  last year, and subtracting its exports from a lifetime total would report every pre-clamp
  kWh as used at home — turning the most cautious number in the app into its most
  overstated one, silently, on the day the hardware arrives.

- **Specific yield — kWh per kWp.** The only production figure comparable with another
  house. Refused outright when the array size is estimated from panel count rather than
  configured, because a measurement divided by a guess renders identically to a real one.
  No verdict attached: whether a figure is good depends on latitude, tilt, azimuth and
  shading, none of which this app knows well enough to grade.

- **Panel degradation, from this array's own learned response.** Watts of AC per W/m² of
  irradiance is snapshotted monthly; its slope across years is this roof's degradation
  rate, with weather divided out by construction. It answers "not yet, and here is how much
  longer" for the first two years — a slope fitted over anything shorter is measuring the
  seasonal sun angle, and would print a confident number from noise. Shipped now because
  the figure cannot be backfilled: deriving it needs output paired with irradiance at the
  time, and every month not recorded is permanently gone.
- **An MCP server**, so you can ask an AI assistant about your own array — production,
  savings, records, panel health, EV charging, alerts and device usage. Read-only:
  changing a setting, acknowledging an alert and controlling a device stay in the
  dashboard. Plain `.mjs` with no dependencies, so there is nothing to install on the
  machine the assistant runs on. See [the guide](guide/mcp.md).

  The renderers carry measured-vs-estimated, kept-vs-forgone and complete-vs-part-period
  into every answer, and say *unknown* rather than zero. Flattening those is how a careful
  figure becomes a confident wrong one, and an assistant sounds equally sure either way.

- **Devices that describe themselves over MQTT** — Home Assistant discovery, read-only.
  Reaches hardware with no other way in: the Pila Mesh battery, which publishes nothing
  else, and Zigbee sensors that have no IP address at all. Value templates beyond simple
  field access are refused and counted rather than half-interpreted.

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
