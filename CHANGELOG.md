# Changelog

## 0.1.5 — 2026-08-05

### Added
- **A Windows installer.** `SolarDashboardSetup.exe` installs the app as a Windows service,
  opens the firewall port, and upgrades in place. It has existed since July and was never
  released: the script that builds it was referenced by nothing but its own usage comment,
  and its version was hardcoded to 0.9.0 while the product shipped 0.1.4 — which would have
  made Inno Setup treat every real release as a downgrade from a version that never existed.
  It reads `package.json` now, and the release builds it on a Windows runner and folds it
  into the same `SHA256SUMS` the maintainer signs.

  Not signed with an Authenticode certificate, so SmartScreen will warn on first run.

- **The `.local` name is a setting** (Settings → Hardware). The dashboard has answered to
  `solar-dashboard.local` for a while, but the name lived in a variable inside the boot
  sequence — changeable only by editing an environment file over SSH. That is fine until two
  installs share a network, where both answer for the same name and renaming one is the only
  fix.

  A bad hostname does not fail loudly; it just never resolves, which from the outside is
  indistinguishable from mDNS being broken. So each refusal is specific — a typed
  `.local`, a dotted name, a leading hyphen and an over-long label each get their own
  message. The IP address stays on screen permanently, because renaming is the one setting
  that can cut off the browser making the change.

- **What is about to expire, and what would absorb it** (Savings → Banked credits). Banked
  credits are forfeited on a fixed date, and nothing on a bill says so. The app projects the
  balance to that date from your daily meter readings and states the extra draw that would
  use it up — in kWh a day, and in hours at your charger's *measured* average power rather
  than an assumed rating.

  Advisory, and that is a decision rather than a first step: drawing power costs money when
  a projection is wrong. It declines without a balance to anchor to, excludes unmetered days
  from the trend — they net out as pure import and make the bank look like it is draining
  faster than it is — and stays quiet under 25 kWh, because a projection is not accurate to
  the kilowatt-hour.

- **A guide to how your plan is modelled** ([guide/plans.md](guide/plans.md)). The tariff
  engine had one README bullet and no guide. Four plans, why self-use beats export under net
  metering, what the price-before-or-after-tax setting costs when it is wrong, and the three
  ways the credit bank is tracked.

### Changed
- **Settings says less, and explains on request.** Every field carried a sentence or two of
  permanent help, so the tabs read as prose with controls embedded rather than as controls.
  Nothing was cut — it moved behind the ⓘ the Savings page has used since its own caveats
  turned a table of numbers into an essay, still one gesture away and still read aloud by a
  screen reader. Rates went from 379 words to 147, and Alerts and Updates were already short
  and were left alone.

### Fixed
- **In-app updates are refused on anything but Linux.** This is a bug fix, not a scoping
  decision. Node reports the architecture as `x64` on Windows and Linux alike, so the
  updater resolved `solar-dashboard-x64.tar.gz` on both — the *Linux* bundle. A Windows
  install would have found it, verified its signature perfectly happily, and unpacked ELF
  binaries over a working installation. The signature cannot catch that: the bundle is
  genuine, it is simply for the wrong operating system. Windows upgrades via the installer,
  and the panel says so.

## 0.1.4 — 2026-08-04

### Added
- **A year of production as a grid, one square per day** (Trends). A line chart answers
  "how much yesterday" well and "what does a year look like" badly — 365 points on a 600px
  axis is four pixels a day, and the seasonal arc, the week under snow and the fortnight an
  inverter was down are exactly what gets averaged into a smooth curve.

  Scaled to the best day rather than a fixed ceiling, since array sizes differ by an order
  of magnitude and a hardcoded maximum draws a 3 kW system as uniformly black. The range
  comes from the data, so a three-week-old install shows three weeks rather than eleven
  months of empty cells.

  **The same days are available as a table**, which is not a fallback for a broken chart but
  the only view that carries values — you cannot read 43.2 kWh off a green square, and a
  reader who cannot separate the hues reads nothing at all. Both views come from one array
  and paint from one ramp, so they cannot disagree.

- **Share your output with PVOutput** (Settings → Data). The long-running public register of
  domestic solar, and what makes "is 76 kWh a good day for an array this size in this
  climate" answerable at all — the comparison needs other people's roofs.

  This is the only feature in the app that sends anything off your machine, and it says so
  on the card rather than in a footnote. Off unless switched on, and it cannot be switched
  on without an API key and system id you entered yourself. The key is write-only: the app
  reports whether one is stored, never what it is, so the field stays empty and blank means
  "keep the one you have".

  Spends at most a third of the free hourly allowance, read back from PVOutput's own
  rate-limit headers rather than counted locally — the key is yours and may be feeding a
  phone widget or an inverter script too. A refusal that will not change, like a wrong key,
  switches the uploader off with the reason kept rather than retrying forever.

- **Every notification is kept, and readable in the app** (System → Health). These used to
  exist only as a push: the notifier resolved a webhook and returned early when there was
  none, which on a default install is always — so the sunset daily summary, which appears
  nowhere else, was composed every evening and dropped.

  Recorded before the delivery attempt, so the log is complete whether or not a webhook
  exists. Three states rather than two: delivered, failed with a reason, and neither — the
  last being an install with no webhook, which is normal rather than broken. Keeping those
  apart also surfaces a webhook that has been failing for a fortnight while every alert
  looks raised and the phone is simply silent.

- **The export-credit bank, counted from your meter instead of waited for.** The balance
  used to be typed off a bill because the app saw production and nothing else. Imported
  meter data ends that: both directions are known per day, from the same meter the bill is
  calculated from, so the change between two bills is arithmetic.

  What it still cannot do is invent the starting point. A bank balance is a running total
  that predates anything this app has seen, so with no bill to anchor to it reports the
  **change** since the data begins and refuses to call it a balance — a change presented as
  a balance is wrong by exactly whatever was already in the bank. Enter one figure off any
  bill and it counts forward from there.

  It folds day by day rather than netting the period, because a bank does not go negative:
  it empties and the rest is bought with money, and one subtraction would carry an
  overdraft forward that never existed. Energy produced on days the meter recorded no
  export is reported separately and kept out of the balance — the utility did not count it,
  so it is not in their bank either and never will be.

- **"Solar used as you make it" can now be measured rather than typed** (Settings → Rates).
  It is the most load-bearing guess in the app — it decides how much unmetered production
  is valued at the self-use rate rather than the export one — and everyone types a round
  number because nobody knows theirs. Across the days a meter covered, what stayed home is
  production minus export, so the share is arithmetic and it belongs to *this* roof.

  Opt-in, and shown before you choose: the toggle displays the measured figure, how many
  days it rests on, and how much energy that was. Silently replacing a number someone
  entered with one computed here would leave them looking at a figure they did not choose
  and cannot trace. Applied only to days no meter reached — those are still an assumption,
  just one calibrated on the same house.

  The floor is one full week, because household load runs on a weekly cycle and five days
  is a biased slice of it rather than a smaller version. It does not cover the year and
  does not pretend to, which is why the window is printed beside the figure.

- **An alert while the meter is not counting what leaves the property.** Days where the
  array produced and the meter recorded no export usually mean net metering has not been
  activated — the energy leaves and nobody is billed for it. Windowed against the newest
  reading rather than against today, because a usage export always lags and measuring from
  now would go quiet during exactly the weeks the fault was still running and merely
  unpublished.

### Changed
- **The Health page answers "is anything wrong?" before explaining anything.** It ran to
  about seven hundred words across three systems that each presented themselves in full —
  the alert engine, the array census with a paragraph under every finding, and the fleet
  vitals — and none of them answered the question the page exists for.

  Now a verdict you can read without focusing, ranked by the worst thing present rather than
  by how many: one dead inverter outranks five notes about panel counts. Informational
  findings do not colour it at all, because a page that goes amber over "worth checking your
  contract" has amber that means nothing by the second week.

  Alerts and census findings merge into one ranked list at one line apiece, with the prose
  behind a click. The split was an implementation detail leaking into the interface — nobody
  cares which subsystem noticed a problem, only how bad it is. The census also raised its
  findings as alerts, so some arrived twice under different wordings; deduplicated now.

  Stale data outranks the verdict entirely: "all clear" computed from readings that stopped
  arriving three hours ago is not health, it is the last health the app saw, and the two are
  indistinguishable until somebody checks a timestamp nobody reads.

- **A meter now measures the days it covers instead of being discarded whole.** Coverage
  was all-or-nothing: a period counted as measured only if the meter reached across every
  day of it. A published usage export always ends weeks before today, so no period ever
  qualified and every imported measurement was thrown away the moment it arrived — four
  periods still reporting an estimate, minutes after importing a month of real data. Each
  day is now measured or estimated on its own, and the Savings page says how much of a
  period rests on which.

- **The unmetered-day caveat moved from the Savings page to an alert.** It stated the app's
  bookkeeping ("excluded from the measured figures above") where the credit bank now states
  the loss, and it read identically whether the gap ended in July or was still running this
  week. A line that cannot tell those apart carries no signal in either direction.

### Fixed
- **The release signing script finds `gh` and `minisign` rather than assuming a PATH.**
  Git Bash builds its own, which does not inherit what a package manager amended, so
  "gh is not installed" was reported on a machine where it plainly was.

## 0.1.3 — 2026-08-04

### Added
- **Import your utility's own meter data** (Settings → Rates). Most utilities publish daily
  import and export; that is the same measurement a clamp on the service entrance takes,
  except the meter your bill is calculated from already takes it, needs no hardware, and
  reaches back to the day the array went live. Where both exist the meter wins.

  Spreadsheet or CSV. Columns are recognised where the names are familiar and otherwise
  handed back for you to map, which is what makes a utility nobody has seen before work
  anyway. Names that flip meaning with point of view — "Delivered", "Generation" — match
  nothing on purpose, because either would produce a clean import that is inside out with
  every individual number still plausible.

  **Days the meter recorded no export while the array was producing are flagged and left
  out.** That pattern is a meter that was not counting — a net-metering agreement not yet
  activated — and taken at face value it reads as perfect self-consumption, crediting the
  house with energy it actually gave away on precisely the days its owner was being
  short-changed. The count is shown on the Savings page too, not only at import time.

  **Green Button (ESPI) is read directly**, ahead of any table. It is the one format that
  declares what its numbers mean — direction comes from the file's own `ReadingType`
  rather than a column heading somebody has to interpret — so there is nothing to map and
  nothing to get backwards. Ontario has required it of every electric and gas utility
  since November 2023.

- **A reminder when the utility has published another period.** Once the newest imported
  reading is more than 40 days old, a warning joins the existing alerts and notifications.
  Forty rather than thirty: a billing period is about a month and its export appears
  days-to-weeks after it closes, so a thirty-day timer would fire while the file did not
  exist yet — and a reminder that is usually wrong gets ignored on the occasion it is
  right. Silent on an install that has never imported anything, which is a feature nobody
  chose rather than a lapsed habit.

- **Petrol comparison priced by date, from published fuel prices.** Each drive is now
  valued at the average published for the month it happened in, rather than the whole
  period's distance being multiplied by one hardcoded $1.60/L. Over the last eighteen
  months one city in the published series ran 130.0¢ to 191.1¢ — a flat current price does
  not misprice an old drive slightly, it misprices it by half.

  Prices come from Statistics Canada's table 18-10-0001, which covers every province plus
  a national average and is public, unauthenticated JSON. Cached locally, so an old drive
  keeps its own month's price whatever happens to the feed and the comparison still works
  offline. The provincial regulator publishes a better number — weekly, and regulated —
  but only as an HTML page and only for one province.

  The series is monthly and arrives about six weeks in arrears, so recent drives are
  priced at the newest available figure. That is said out loud rather than smoothed over:
  every result reports how much distance met a price published for its own month and how
  much borrowed a later one.

### Changed
- **The petrol comparison's two assumptions are now settings.** `9 L/100 km` and
  `$1.60/L` were constants inside a React component — not merely wrong but unreachable.
  The price is looked up; the comparison car is asked for, because no feed anywhere knows
  the fuel economy of a vehicle that was never bought.

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
