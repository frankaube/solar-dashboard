# Changelog

## 1.0.0 - 2026-08-25

The first release intended to be run by someone other than its author. Everything
below has been running continuously against a 23 kW array, a Tesla Wall Connector
and a Raspberry Pi 4 since July.

### What it does

**Solar, read locally.** Hoymiles DTUs over their own protobuf on port 10081 —
no vendor cloud, no account. Fronius, OpenDTU, and any inverter speaking SunSpec
over Modbus TCP, which covers Fronius, SMA, SolarEdge, Delta and ABB from one
adapter.

**Per-panel, not just per-array.** A roof map you arrange to match your actual
layout, shaded by live power, temperature, daily energy or each panel's all-time
best. A by-inverter view for when the question is hardware rather than shade —
a failing microinverter's ports can sit in two different rows, and on the map
they read as unrelated dim squares. Panel insights separate time-of-day dips
(a tree, a vent) from all-day ones (soiling, a fault), and clipping detection
finds an inverter passing less AC than its panels are making.

**Money that survives a rate change.** Tariffs with history, so last year's
savings keep the price they were actually worth; net metering, net billing and
credit-bank programs; sales tax handled explicitly, because bills print the
pre-tax rate. Import your utility's own usage export to replace estimates with
measurements.

**EV charging.** Tesla Wall Connector locally, go-e, OCPP and evcc; optional
TeslaMate for vehicle data. Per-session energy, how much of it the roof paid
for, the best window to plug in tomorrow, and fuel savings priced against the
published monthly average for the month each drive happened in.

**Batteries and devices.** Tesla Powerwall, Enphase, EcoFlow, Victron and
SunSpec storage. Shelly, Kasa, Tasmota, ESPHome, HomeKit, Mysa and Daikin for
everything else, with load estimation for the devices that cannot measure
themselves.

**Weather that explains a bad day.** Forecast irradiance against this array's
own learned response, so "expected" means what this roof does rather than what a
nameplate claims — plus optional radar for the afternoons where production fell
off a cliff and the chart cannot say why.

**Alerts worth reading.** A dark array, an inverter that has stopped while the
fleet works, a device that went silent. Only a fault costing production right
now takes the headline; everything else waits on a quiet line. One daily wrap-up
after sunset rather than a push per flap.

**Running it.** Automatic updates from signed releases, backups to S3, Backblaze,
Cloudflare R2 or Google Drive, a Home Assistant MQTT discovery bridge, PVOutput
upload, an MCP server for asking questions in plain language, and a demo mode
that fills the whole app from a described house so you can look before you own
anything.

### What it will not do

It will not tell you the house used 2.7 kW when it cannot separate that from what
went to the grid. It will not print a lifetime figure from a register that is not
one, or a day's total from a counter that winds backwards each evening, or call a
panel healthy because nothing has been heard from it. Where a number is estimated
it says so; where it cannot be known it says that instead.

Everything runs on your hardware. No vendor account, no cloud round-trip, no
telemetry.

## 0.2.0 - 2026-08-24

### Added

- **A Sources page**, answering the one question the rest of the app assumed: is anything
  actually reporting. Every device gets a strip of its last twelve windows, derived from the
  readings already stored rather than from probing — nothing on this page sends a packet to a
  device, because several of them are exactly the kind of hardware that falls over when
  polled.

- **Hourly rollups** of the five-minute record, so a year of history stays answerable without
  keeping a year of five-minute rows in every query. Energy is taken as the counter's
  high-water mark rather than a sum of samples, since the counter survives a gap in
  collection and integrating samples under-reports every hour the app was not watching.
  Nothing is deleted; the rollup is an addition, and a nightly pass reconciles it against the
  rows it was built from.

- **Clipping detection.** A microinverter refusing to pass more AC while the panels keep
  making DC is invisible in an output histogram — power piles up near the daily maximum on
  any clear day, so a healthy array produces a dramatic spike in the top bucket. The test is
  conversion efficiency against DC input, which holds near-constant and breaks at the top
  only when there is a ceiling. It reports nothing on an array that is fine, which is the
  normal answer.

- **Every panel's personal best**, all-time, with the moment it happened — as a fourth map
  mode, beside the roof's health figures, and under each panel's live numbers. Scaled across
  the range the roof actually reached rather than against nameplate: panels peak within a few
  watts of each other, so share-of-rating paints identical squares and says nothing.

- **The car's drive on a map**, with optional street tiles fetched and cached by the Pi so
  the browser never talks to a tile server. Off by default. With streets off it falls back to
  the Natural Earth vectors already bundled for the radar, which work with no internet at
  all. A second frame zooms to the car's immediate surroundings, where street names exist.

- **Two new alert rules**: a bright sky with the array dark and too warm for snow to explain
  it, and an inverter whose warning counter has run far ahead of the fleet while it produces
  nothing.

- **The day's earnings in the tab title**, and **what the roof had made by this time
  yesterday** on the hero figure — a part-day against a whole day says nothing before sunset.

### Changed

- **A standing fault no longer owns the headline.** The Overview hero surrendered its widest
  line to any open alert, so a device unreachable for three days owned it indefinitely and the
  production sentence disappeared entirely. Only a fault costing production right now takes
  that line; everything else gets a quiet named strip at the foot of the band. Acknowledging
  demotes, because that is what the button is for. Age does not, because a dark array on day
  two has cost more than on day one.

- **The charger is polled adaptively**, with backoff. A Tesla Wall Connector's embedded web
  server exhausts under sustained polling and recovers only via the breaker.

### Fixed

- **"Inverters online" counted the reporting inverters against themselves**, so it read
  11 / 11 with two units dead and could never have shown a missing one.

- **The Roof page called a 46-panel roof 42 panels**, having taken its count from the panels
  that send per-panel detail rather than from the ones that exist. The silent ones are now
  counted and named apart rather than folded into the healthy side.

- **The daily wrap-up could arrive mid-afternoon.** It inferred "the day is over" from output
  alone, so anything that stopped the array satisfied it — an installer switching the system
  off at three o'clock produced a congratulatory summary while the roof sat dark. It now
  requires the sun to be down.

- **The warning-count alert could never have cleared**, and then, once it could, cleared
  falsely at dusk. The counter is cumulative rather than an error code, and every
  microinverter is powered by its own panel, so the whole fleet goes quiet every evening.

- **The money counter ticked backwards at sunset.**

## 0.1.7 - 2026-08-13

### Added

- **A day at a time, on an axis pinned to midnight** (Trends). The rolling twenty-four-hour
  chart answers "what is happening now" and cannot answer "what did the roof do on the
  fourth": half of it is the previous day, so its axis means something different every time
  it is opened. Pinned to a date, the axis is always midnight to midnight and the day before
  drops precisely on top, which is the comparison that was wanted in the first place. It is
  behind a checkbox, and navigation stops where the record does in both directions, because
  walking past either end lands on a day that is empty for a reason nothing on screen
  explains.

  Days come from the `localDate` the collector already stamps on every reading rather than
  from timestamp arithmetic, since which day a reading counts toward is a decision that must
  not have two implementations. The total is the gateway's cumulative counter at its highest
  rather than a sum of the curve: the counter survives a gap in collection, and integrating
  five-minute samples would under-report every day the app was not watching.

  A day with no readings and a day the array made nothing are both a flat line, and only one
  of them is about the weather, so the panel says which it is rather than leaving it to be
  inferred. It also says when part of a day was imported rather than measured.

- **What the roof was doing at this time yesterday**, in the expected-vs-actual tooltip.
  That chart asks whether the roof is keeping up with the sky and raises the question it does
  not answer, which is "compared to what": 10.7 kW is a fine morning after a wet day and a
  poor one after a clear day.

  Matched on the wall clock rather than on elapsed hours. "Yesterday at 11:07" and "24 hours
  ago" are the same instant on 363 days a year and an hour apart on the other two, and for a
  solar curve an hour is a different sun angle, which is the whole basis of the comparison.
  Nothing is interpolated: where yesterday has no reading within six minutes of that moment,
  the answer is null and the line is simply absent, because a comparison against a number
  nobody measured reads like one that was.

### Changed

- **The three-hour sparkline beside the hero figure is gone.** It repeated what the chart
  below it already showed, at a size too small to read, and the hero reads better without a
  second thing competing for the same glance.

- **The whole app got faster**, most of it from two causes. `Intl.DateTimeFormat`
  construction costs about ten times the `format()` call it enables, and one was being built
  for every row of every rollup; timestamps were being re-parsed thousands of times per
  request. Panel insights went from 2.38s to 0.46s, savings from 0.95s to 0.05s, statistics
  from 0.89s to 0.09s, production from 0.76s to 0.13s, and the scatter plots from roughly
  0.48s to 0.09s. The lifetime-energy query fell from 787ms to 48ms by joining against the
  latest reading per port rather than making SQLite build a temporary B-tree over every row.

### Fixed

- **A utility import now says how much of itself can be used.** A usage export reaches back
  to the meter's installation while this app's record starts when it was switched on, so
  days older than that are stored and then skipped by every calculation: measured
  self-consumption is production minus export, and there is no production term. Reporting
  "29 days stored" while nine of them can never move a figure is true and implies something
  false, which is how a working import comes to look broken. The preview names those days
  and why they do not count, as information rather than a warning.

  Committing an import also clears the savings cache now, which it never did. The one-minute
  expiry meant it healed itself, but meter days outrank every estimate the figures fall back
  on, and answering from the pre-import cache is the thing the rate and tariff endpoints
  already call `invalidate()` to avoid.

- **The hour a panel's losses were attributed to came from the host clock.** `localHourOf`
  built its formatter from the site timezone at module load, so the answer depended on where
  the machine sat rather than on the argument. It decides whether a deficit is reported as
  shading or as soiling. The zone is now a parameter defaulting to the site's, matching
  `localDateOf`, and the memo is keyed by zone as well as by hour so one zone's answer can
  never be handed back for another.

- **The yesterday line reached one chart out of two**, and on the rolling window it was drawn
  against an axis whose left half is already yesterday, so it could never line up with the
  curve beside it. It is a tooltip value on that chart now, and a drawn line only where the
  axis is a fixed day.

- **The first command in the quick start was a placeholder.** `git clone <this-repo>` is what
  a visitor runs before anything else, and it fails.

### Internal

- The publish audit's own test suite kept its evidence: three CI failures were diagnosed by
  guesswork because it captured `publish.sh`'s output, asserted against it and then discarded
  it. It also needed a deny list it could not have, a probe term that is not a literal in the
  tree it scans, and a git identity for the throwaway clone, since a runner has none and
  `commit-tree` exits 128 without one.

- Em-dashes are gone from the documentation, rewritten into the punctuation each sentence
  actually wanted rather than substituted.

## 0.1.6 - 2026-08-06

### Fixed

- **A blank coordinate is no longer zero degrees.** The Pi installer wrote `SITE_LATITUDE=`
  into `.env` under a comment promising that unset meant the forecast stayed off. An empty
  environment variable is `''` rather than undefined, `Number('')` is `0`, and `0` is
  finite, so every install made that way sat at 0°, 0° and fetched a real forecast for the
  Gulf of Guinea. Nothing errored. A roof at 46°N was told it gets twelve hours of August
  daylight instead of fifteen, and expected-vs-actual, sunrise, sunset, cloud cover and the
  choice of radar source were all quietly about somewhere else.

  Blank now means absent wherever a coordinate is read, the installer writes those keys
  commented out, and the guard against 0°, 0° that the car's home always had is now the
  site's too. The two were parsed by two code paths with two sets of rules, which is
  exactly why only one of them caught it.

- **Notifications with an emoji in the title were never sent.** An HTTP header value is a
  ByteString and the titles begin with an emoji by design, so `fetch` threw before the
  request left the process. Four of eighteen on the install where this was found had been
  composed, logged and never delivered. The alert appears either way, and only a column
  nobody reads said it went nowhere. Encoded as an RFC 2047 word now, so the emoji still
  reaches the phone.

- **An update could not deliver a changed systemd unit.** Everything in an update replaces
  what is under `/opt`; systemd reads from `/etc/systemd/system`; nothing copied between
  them. A release could add a timer and every existing install would carry the new file
  around indefinitely while running the old one. The updater and the deploy script now sync
  units and enable new timers.

- **The Trends range buttons could not change anything, and did not say so.** The wiring was
  fine: the click registered and the refetch fired. On an install with a fortnight of
  history, 30 days, 90 days and a year are the same fortnight, so the chart redrew
  identically. Longer ranges are now offered only once history reaches past the shortest,
  and the caption says how much has been recorded.

- **PVOutput** keeps its upload state across a restart, and asks for the rate-limit headers,
  which are opt-in and were therefore never arriving.

### Added

- **Where the panels are, asked during setup.** A scan finds a gateway, a charger and a
  dozen plugs; it cannot find a latitude, and setup never asked for one. It does now, with a
  one-press option to take it from the browser, never automatically, and showing the
  accuracy, because the machine doing the configuring is often not the one at the house.
  Skipping still finishes.

  There is also a Site location card in Settings → Hardware, which did not exist at all
  before: an environment variable or a REST call were the only ways to set the value that
  the most features depend on.

- **The car's home follows the site by default.** They are the same driveway in all but the
  odd install, and two independently-editable records of one fact drift apart while both
  look set. Following reads the site each time rather than copying it. An install that has
  already typed its own coordinates keeps them.

- **The Pi repairs its own network, and says when it had to.** A watchdog checks the default
  route every minute and escalates only as far as it must (bounce the link, reload the
  driver, reboot), written after an install went quiet for three and a half hours with the
  kernel running happily and nothing crashed, so nothing restarted. The app also checks in
  with systemd on every poll cycle, because `Restart=on-failure` only ever caught a process
  that exits, and the hardware watchdog the Pi has and systemd does not use by default is
  now enabled.

  Every repair is recorded and shown on the Health page. A box quietly rebooting itself each
  night looks identical to a healthy one from the dashboard, and self-healing that hides the
  fault trades a visible outage for an invisible decline.

- **Fill a gap in the history, from the app.** The repair for a collection gap existed only
  as a script that opened the database with Prisma, unusable on a Pi, which ships one
  executable with no Node. Settings → Data now takes a vendor export, previews what it would
  write, refuses anything a real reading already covers, marks imported rows as imported and
  rebuilds energy from the power curve, so an import cannot inflate a day.

- **Weather radar**, off by default and fetched by the server so the browser never talks to
  the source. Coastlines, borders and lakes are drawn under the rain from public-domain
  Natural Earth vectors compiled into the binary, with no tile server and nothing fetched at
  runtime, because a precipitation layer with no geography under it cannot tell you whether
  a cell is overhead or over the next county.

- **Cloud cover beside irradiance** on Trends, inverted so the shape grows downward as the
  sky closes in.

- **Electricity prices are kept in time.** Each period is valued at the rate in effect when
  the energy flowed, rather than repricing all history at today's number.

- **Motion, where it says something.** Figures count to their new value, cards stagger in,
  what changed since the last poll is marked, a three-hour sparkline sits beside the hero
  figure, and energy leaving the roof runs along the base of the hero card at about ten
  seconds a cycle, because peripheral motion on a screen somebody leaves open all day has to be
  ignorable. All of it respects `prefers-reduced-motion`.

### Internal

- Render tests for the pages rather than only the functions behind them; a suite for the
  network watchdog with every destructive verb stubbed; a test that forces the publish audit
  to fail and asserts it refuses; and the audit itself now searches with lines joined, after
  a denied phrase was found hiding in a line break where a line-based search could not see
  it.

## 0.1.5 - 2026-08-05

### Added
- **A Windows installer.** `SolarDashboardSetup.exe` installs the app as a Windows service,
  opens the firewall port, and upgrades in place. It has existed since July and was never
  released: the script that builds it was referenced by nothing but its own usage comment,
  and its version was hardcoded to 0.9.0 while the product shipped 0.1.4, which would have
  made Inno Setup treat every real release as a downgrade from a version that never existed.
  It reads `package.json` now, and the release builds it on a Windows runner and folds it
  into the same `SHA256SUMS` the maintainer signs.

  Not signed with an Authenticode certificate, so SmartScreen will warn on first run.

- **The `.local` name is a setting** (Settings → Hardware). The dashboard has answered to
  `solar-dashboard.local` for a while, but the name lived in a variable inside the boot
  sequence, changeable only by editing an environment file over SSH. That is fine until two
  installs share a network, where both answer for the same name and renaming one is the only
  fix.

  A bad hostname does not fail loudly; it just never resolves, which from the outside is
  indistinguishable from mDNS being broken. So each refusal is specific: a typed
  `.local`, a dotted name, a leading hyphen and an over-long label each get their own
  message. The IP address stays on screen permanently, because renaming is the one setting
  that can cut off the browser making the change.

- **What is about to expire, and what would absorb it** (Savings → Banked credits). Banked
  credits are forfeited on a fixed date, and nothing on a bill says so. The app projects the
  balance to that date from your daily meter readings and states the extra draw that would
  use it up, in kWh a day, and in hours at your charger's *measured* average power rather
  than an assumed rating.

  Advisory, and that is a decision rather than a first step: drawing power costs money when
  a projection is wrong. It declines without a balance to anchor to, excludes unmetered days
  from the trend (they net out as pure import and make the bank look like it is draining
  faster than it is), and stays quiet under 25 kWh, because a projection is not accurate to
  the kilowatt-hour.

- **A guide to how your plan is modelled** ([guide/plans.md](guide/plans.md)). The tariff
  engine had one README bullet and no guide. Four plans, why self-use beats export under net
  metering, what the price-before-or-after-tax setting costs when it is wrong, and the three
  ways the credit bank is tracked.

### Changed
- **Settings says less, and explains on request.** Every field carried a sentence or two of
  permanent help, so the tabs read as prose with controls embedded rather than as controls.
  Nothing was cut; it moved behind the ⓘ the Savings page has used since its own caveats
  turned a table of numbers into an essay, still one gesture away and still read aloud by a
  screen reader. Rates went from 379 words to 147, and Alerts and Updates were already short
  and were left alone.

### Fixed
- **In-app updates are refused on anything but Linux.** This is a bug fix, not a scoping
  decision. Node reports the architecture as `x64` on Windows and Linux alike, so the
  updater resolved `solar-dashboard-x64.tar.gz` on both, meaning the *Linux* bundle. A Windows
  install would have found it, verified its signature perfectly happily, and unpacked ELF
  binaries over a working installation. The signature cannot catch that: the bundle is
  genuine, it is simply for the wrong operating system. Windows upgrades via the installer,
  and the panel says so.

## 0.1.4 - 2026-08-04

### Added
- **A year of production as a grid, one square per day** (Trends). A line chart answers
  "how much yesterday" well and "what does a year look like" badly: 365 points on a 600px
  axis is four pixels a day, and the seasonal arc, the week under snow and the fortnight an
  inverter was down are exactly what gets averaged into a smooth curve.

  Scaled to the best day rather than a fixed ceiling, since array sizes differ by an order
  of magnitude and a hardcoded maximum draws a 3 kW system as uniformly black. The range
  comes from the data, so a three-week-old install shows three weeks rather than eleven
  months of empty cells.

  **The same days are available as a table**, which is not a fallback for a broken chart but
  the only view that carries values: you cannot read 43.2 kWh off a green square, and a
  reader who cannot separate the hues reads nothing at all. Both views come from one array
  and paint from one ramp, so they cannot disagree.

- **Share your output with PVOutput** (Settings → Data). The long-running public register of
  domestic solar, and what makes "is 76 kWh a good day for an array this size in this
  climate" answerable at all, because the comparison needs other people's roofs.

  This is the only feature in the app that sends anything off your machine, and it says so
  on the card rather than in a footnote. Off unless switched on, and it cannot be switched
  on without an API key and system id you entered yourself. The key is write-only: the app
  reports whether one is stored, never what it is, so the field stays empty and blank means
  "keep the one you have".

  Spends at most a third of the free hourly allowance, read back from PVOutput's own
  rate-limit headers rather than counted locally, since the key is yours and may be feeding a
  phone widget or an inverter script too. A refusal that will not change, like a wrong key,
  switches the uploader off with the reason kept rather than retrying forever.

- **Every notification is kept, and readable in the app** (System → Health). These used to
  exist only as a push: the notifier resolved a webhook and returned early when there was
  none, which on a default install is always, so the sunset daily summary, which appears
  nowhere else, was composed every evening and dropped.

  Recorded before the delivery attempt, so the log is complete whether or not a webhook
  exists. Three states rather than two: delivered, failed with a reason, and neither, the
  last being an install with no webhook, which is normal rather than broken. Keeping those
  apart also surfaces a webhook that has been failing for a fortnight while every alert
  looks raised and the phone is simply silent.

- **The export-credit bank, counted from your meter instead of waited for.** The balance
  used to be typed off a bill because the app saw production and nothing else. Imported
  meter data ends that: both directions are known per day, from the same meter the bill is
  calculated from, so the change between two bills is arithmetic.

  What it still cannot do is invent the starting point. A bank balance is a running total
  that predates anything this app has seen, so with no bill to anchor to it reports the
  **change** since the data begins and refuses to call it a balance, because a change presented as
  a balance is wrong by exactly whatever was already in the bank. Enter one figure off any
  bill and it counts forward from there.

  It folds day by day rather than netting the period, because a bank does not go negative:
  it empties and the rest is bought with money, and one subtraction would carry an
  overdraft forward that never existed. Energy produced on days the meter recorded no
  export is reported separately and kept out of the balance. The utility did not count it,
  so it is not in their bank either and never will be.

- **"Solar used as you make it" can now be measured rather than typed** (Settings → Rates).
  It is the most load-bearing guess in the app, deciding how much unmetered production
  is valued at the self-use rate rather than the export one, and everyone types a round
  number because nobody knows theirs. Across the days a meter covered, what stayed home is
  production minus export, so the share is arithmetic and it belongs to *this* roof.

  Opt-in, and shown before you choose: the toggle displays the measured figure, how many
  days it rests on, and how much energy that was. Silently replacing a number someone
  entered with one computed here would leave them looking at a figure they did not choose
  and cannot trace. Applied only to days no meter reached, which are still an assumption,
  just one calibrated on the same house.

  The floor is one full week, because household load runs on a weekly cycle and five days
  is a biased slice of it rather than a smaller version. It does not cover the year and
  does not pretend to, which is why the window is printed beside the figure.

- **An alert while the meter is not counting what leaves the property.** Days where the
  array produced and the meter recorded no export usually mean net metering has not been
  activated: the energy leaves and nobody is billed for it. Windowed against the newest
  reading rather than against today, because a usage export always lags and measuring from
  now would go quiet during exactly the weeks the fault was still running and merely
  unpublished.

### Changed
- **The Health page answers "is anything wrong?" before explaining anything.** It ran to
  about seven hundred words across three systems that each presented themselves in full
  (the alert engine, the array census with a paragraph under every finding, and the fleet
  vitals), and none of them answered the question the page exists for.

  Now a verdict you can read without focusing, ranked by the worst thing present rather than
  by how many: one dead inverter outranks five notes about panel counts. Informational
  findings do not colour it at all, because a page that goes amber over "worth checking your
  contract" has amber that means nothing by the second week.

  Alerts and census findings merge into one ranked list at one line apiece, with the prose
  behind a click. The split was an implementation detail leaking into the interface. Nobody
  cares which subsystem noticed a problem, only how bad it is. The census also raised its
  findings as alerts, so some arrived twice under different wordings; deduplicated now.

  Stale data outranks the verdict entirely: "all clear" computed from readings that stopped
  arriving three hours ago is not health, it is the last health the app saw, and the two are
  indistinguishable until somebody checks a timestamp nobody reads.

- **A meter now measures the days it covers instead of being discarded whole.** Coverage
  was all-or-nothing: a period counted as measured only if the meter reached across every
  day of it. A published usage export always ends weeks before today, so no period ever
  qualified and every imported measurement was thrown away the moment it arrived: four
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

## 0.1.3 - 2026-08-04

### Added
- **Import your utility's own meter data** (Settings → Rates). Most utilities publish daily
  import and export; that is the same measurement a clamp on the service entrance takes,
  except the meter your bill is calculated from already takes it, needs no hardware, and
  reaches back to the day the array went live. Where both exist the meter wins.

  Spreadsheet or CSV. Columns are recognised where the names are familiar and otherwise
  handed back for you to map, which is what makes a utility nobody has seen before work
  anyway. Names that flip meaning with point of view ("Delivered", "Generation") match
  nothing on purpose, because either would produce a clean import that is inside out with
  every individual number still plausible.

  **Days the meter recorded no export while the array was producing are flagged and left
  out.** That pattern is a meter that was not counting, a net-metering agreement not yet
  activated, and taken at face value it reads as perfect self-consumption, crediting the
  house with energy it actually gave away on precisely the days its owner was being
  short-changed. The count is shown on the Savings page too, not only at import time.

  **Green Button (ESPI) is read directly**, ahead of any table. It is the one format that
  declares what its numbers mean: direction comes from the file's own `ReadingType`
  rather than a column heading somebody has to interpret, so there is nothing to map and
  nothing to get backwards. Ontario has required it of every electric and gas utility
  since November 2023.

- **A reminder when the utility has published another period.** Once the newest imported
  reading is more than 40 days old, a warning joins the existing alerts and notifications.
  Forty rather than thirty: a billing period is about a month and its export appears
  days-to-weeks after it closes, so a thirty-day timer would fire while the file did not
  exist yet, and a reminder that is usually wrong gets ignored on the occasion it is
  right. Silent on an install that has never imported anything, which is a feature nobody
  chose rather than a lapsed habit.

- **Petrol comparison priced by date, from published fuel prices.** Each drive is now
  valued at the average published for the month it happened in, rather than the whole
  period's distance being multiplied by one hardcoded $1.60/L. Over the last eighteen
  months one city in the published series ran 130.0¢ to 191.1¢, and a flat current price does
  not misprice an old drive slightly, it misprices it by half.

  Prices come from Statistics Canada's table 18-10-0001, which covers every province plus
  a national average and is public, unauthenticated JSON. Cached locally, so an old drive
  keeps its own month's price whatever happens to the feed and the comparison still works
  offline. The provincial regulator publishes a better number, weekly and regulated,
  but only as an HTML page and only for one province.

  The series is monthly and arrives about six weeks in arrears, so recent drives are
  priced at the newest available figure. That is said out loud rather than smoothed over:
  every result reports how much distance met a price published for its own month and how
  much borrowed a later one.

### Changed
- **The petrol comparison's two assumptions are now settings.** `9 L/100 km` and
  `$1.60/L` were constants inside a React component, not merely wrong but unreachable.
  The price is looked up; the comparison car is asked for, because no feed anywhere knows
  the fuel economy of a vehicle that was never bought.

## 0.1.2 - 2026-08-04

### Added
- **Self-consumption measured at the mains, instead of typed in.** Mark a meter as clamped
  on the service entrance (Devices → the meter → "this is the main service") and what the
  house used directly becomes production minus what actually left the property. No
  appliance has to be identified or metered; the boundary is measured instead of the
  contents. Until then the owner's estimated share still applies, and every figure derived
  from it still says so.

  Only for periods the clamp fully covers. A meter fitted in March has nothing to say about
  last year, and subtracting its exports from a lifetime total would report every pre-clamp
  kWh as used at home, turning the most cautious number in the app into its most
  overstated one, silently, on the day the hardware arrives.

- **Specific yield, kWh per kWp.** The only production figure comparable with another
  house. Refused outright when the array size is estimated from panel count rather than
  configured, because a measurement divided by a guess renders identically to a real one.
  No verdict attached: whether a figure is good depends on latitude, tilt, azimuth and
  shading, none of which this app knows well enough to grade.

- **Panel degradation, from this array's own learned response.** Watts of AC per W/m² of
  irradiance is snapshotted monthly; its slope across years is this roof's degradation
  rate, with weather divided out by construction. It answers "not yet, and here is how much
  longer" for the first two years, because a slope fitted over anything shorter is measuring the
  seasonal sun angle, and would print a confident number from noise. Shipped now because
  the figure cannot be backfilled: deriving it needs output paired with irradiance at the
  time, and every month not recorded is permanently gone.
- **An MCP server**, so you can ask an AI assistant about your own array: production,
  savings, records, panel health, EV charging, alerts and device usage. Read-only:
  changing a setting, acknowledging an alert and controlling a device stay in the
  dashboard. Plain `.mjs` with no dependencies, so there is nothing to install on the
  machine the assistant runs on. See [the guide](guide/mcp.md).

  The renderers carry measured-vs-estimated, kept-vs-forgone and complete-vs-part-period
  into every answer, and say *unknown* rather than zero. Flattening those is how a careful
  figure becomes a confident wrong one, and an assistant sounds equally sure either way.

- **Devices that describe themselves over MQTT**: Home Assistant discovery, read-only.
  Reaches hardware with no other way in: the Pila Mesh battery, which publishes nothing
  else, and Zigbee sensors that have no IP address at all. Value templates beyond simple
  field access are refused and counted rather than half-interpreted.

## 0.1.1 - 2026-08-04

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
  reload, because updates land on a timer, and a page that reloads itself will do it while
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
  they were being read in the host's timezone, three hours in the future on Atlantic
  time, across every drive, charge, update and battery sample.
- **The power tooltip printed `7,005.053684210526`** and labelled watts against an axis in
  kW. Both series now read `7.01 kW`.
- **The mobile tab bar** crowded all five tabs into the left quarter of the screen.
- An update never deletes data: not on install, not on rollback, not on a schema change.
  Asserted by fingerprinting `data/` and `backups/` before and after every scenario.
- `.gitattributes` forces LF on shell scripts and unit files. A fresh clone on Windows
  would previously ship an updater with a CR in its shebang, which Linux reports as
  "not found" for a file that is plainly there.

### Notes
Licensed AGPL-3.0-or-later. Shipped briefly as Apache-2.0 by mistake and corrected before
any outside contributor existed, which is the only cheap moment to change a licence.

Verify the download before installing it. An unsigned build is one the updater will
refuse anyway:

```bash
minisign -Vm SHA256SUMS -P <public key>
sha256sum -c SHA256SUMS --ignore-missing
```
