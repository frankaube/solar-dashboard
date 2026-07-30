# Solar Dashboard

**Self-hosted, local-first home energy monitoring.** It scans your network, finds the
inverters, meters, plugs and thermostats already in the house, and turns them into one
honest picture of what the roof produced, where it went, and what it was worth.

Everything runs on your hardware. No vendor account, no cloud round-trip, no telemetry
leaving the house. Where a device is cloud-only, that's documented as a limitation
rather than papered over.

First developed against a rooftop Hoymiles array, built to generalise to other homes
and vendors.

---

## What it talks to

| | |
|---|---|
| **Solar** | Hoymiles DTU (local protobuf, no cloud), Fronius, OpenDTU, **SunSpec over Modbus TCP** |
| **Devices** | Shelly (Gen1 + Gen2+), Kasa, Tasmota, ESPHome, HomeKit/HAP, Mysa, **Daikin** |
| **Found, not yet readable** | **Tuya** — seen on the network, but local control needs a key only Tuya's cloud issues |
| **EV** | Tesla Wall Connector (local API); vehicle data via the optional TeslaMate |
| **Weather** | Open-Meteo forecast + irradiance, for expected-vs-actual |

**SunSpec is the multiplier.** Fronius, SMA, SolarEdge, Delta and ABB all implement the
same register map, so one adapter covers inverters we could never test individually.

**ESPHome is the escape hatch.** Anything you can bridge onto an ESP32 — a mini split's
CN105 port, a Modbus meter, a bare GPIO — arrives here as an ordinary metered device.

**Daikin is the rare one that measures itself.** Most heat pumps report no energy at
all; Daikin's legacy Wi-Fi adaptors publish real daily kWh. For everything else,
declare what a plug runs and its energy is estimated from on-time — with the
confidence that load type earns, so a heater's figure and a variable-speed pump's are
never presented as equally solid.

The scan reports **what it looked for**, not just what it found — so "no Tuya devices
here" can be told apart from "we never checked".

---

## Quick start

```bash
git clone <this-repo> solar-dashboard
cd solar-dashboard
cp .env.example .env
docker compose up -d --build
```

Open **http://localhost:8080** and follow the onboarding wizard: enter your subnet
(e.g. `192.168.1`), scan, and adopt what it finds. Configuration lives in the app, not
in env files.

No hardware yet? **Settings → Demo mode** loads about two years of generated data.

### Before first start

Only one value is mandatory, and only if you want the TeslaMate vehicle logger:

```bash
openssl rand -base64 24    # put the result in .env as TESLAMATE_ENCRYPTION_KEY
```

It encrypts your Tesla API tokens at rest. There is deliberately no default — a
shipped default would be a key every install shares. Compose refuses to start without
it. Don't lose it; changing it later means re-authenticating TeslaMate.

If you don't have a Tesla, comment out the `teslamate` service in
`docker-compose.yml` and skip this entirely.

### Poll interval — don't lower it

**Keep `POLL_INTERVAL_MS` at 300000 (5 minutes) on a Hoymiles DTU.** Polling every
30 s starves the DTU's own cloud uplink — its firmware handles one connection at a
time. This is observed behaviour, not a guess.

---

## Running it on a Raspberry Pi

A good idea, and the reason is boring: this is a service that runs 24/7 forever, so
its idle draw is most of its lifetime cost.

| Host | Typical draw | Per year @ 16¢/kWh |
|---|---|---|
| Raspberry Pi 5 | ~6 W | **~$8** |
| Mini PC (N100) | ~12 W | ~$17 |
| Desktop tower | ~60 W | ~$84 |

Roughly **$75/yr** saved over a desktop — which is most of the cost of the Pi in the
first year. *Typical figures, not measured on this workload; your numbers will differ.*

Worth being honest about the exception: if the machine is already on for other
reasons, the marginal saving is zero. The saving is real only when the host exists
solely to run this.

### Pick your path

**Lite build — recommended if you don't need TeslaMate.** One self-contained binary,
SQLite only, no Docker, no Postgres. Dramatically lighter on a Pi.

```bash
node packaging/build.mjs arm64
```

Copy the resulting folder to the Pi and run it. A 2 GB Pi 4 is plenty.

**Docker — if you want the vehicle logger.** All images are multi-arch and run on
arm64 unmodified.

```bash
docker compose up -d --build
```

TeslaMate is Elixir/Phoenix plus its own Postgres, so budget for it: **4 GB minimum,
8 GB comfortable.** Building the API image on the Pi itself is slow; consider building
on a desktop and pushing to a registry.

### ⚠️ Do not run this from an SD card

This app writes every five minutes, forever, and TeslaMate's Postgres writes more.
That workload kills SD cards — usually somewhere between six and eighteen months, and
always without warning.

**Boot from a USB SSD**, or an NVMe HAT on a Pi 5. This is the single most important
thing on this page for a Pi deployment; it is the difference between a monitor that
runs for years and one that silently dies next spring taking your history with it.

#### Or: keep the OS on the card and move only the database

Booting from USB is cleanest, but it is not the only arrangement that works. What
kills a card is the *write* workload, not the operating system sitting on it — so
putting `DATABASE_URL` on an external drive and leaving the OS where it is solves
the same problem:

On the Lite build — which is what the install steps below use — that is one line in
`/opt/solar-dashboard/.env`, and `install.sh` writes it for you if you pass the mount
point:

```bash
SOLAR_DATA_DIR=/mnt/data
```

Under Docker it is a volume instead:

```yaml
# docker-compose.yml — the database on a mounted external drive
volumes:
  - /mnt/data:/data
```

A spinning USB hard drive is a good choice here, better than an SSD in one respect:
it has no write-endurance limit to use up at all.

Then point backups at the SD card, and note *why* that is the right way round
rather than the obvious one:

| What fails | DB on USB, backups on the card | Both on the USB drive |
|---|---|---|
| A bad deploy, or your own mistake | recoverable | recoverable |
| The USB drive dies | **recoverable** | everything gone |
| The card dies | DB intact, reflash and restore | recoverable |
| The Pi is stolen, drowned, or fried | gone | gone |

Keeping a database and its backups on two different devices survives either one
failing. A daily 5 MB snapshot is about 1.8 GB a year, which a 64 GB card will not
notice — the write wear that kills cards comes from the database, and that is
exactly what you moved off.

The last row is the one a second device cannot fix. Add an off-site destination
(see Backups above) if the history matters to you.

> **Power.** A bus-powered 2.5" drive can pull 4–5 W spinning up, on top of the Pi's
> own 3–7 W. Kit power supplies are usually 15 W, and the surge is enough to brown out
> a Pi 4 — which is a bad thing to do to a database mid-write. Use a mains-powered
> drive or a powered USB hub. `dmesg | grep -i voltage` will tell you if it is
> happening; the on-screen lightning bolt only appears if you have a display attached.

Back up regardless — `scripts/backup.sh` on the Pi (`scripts/backup.ps1` on Windows).
Both take a consistent SQLite snapshot rather than copying a live file, dump
TeslaMate's Postgres, keep the newest 12, and carry a scheduling command in the header.

### Installing it, start to finish

Tested target: Raspberry Pi 4B, **64-bit Raspberry Pi OS Bookworm or newer**. Both
constraints are hard — Prisma ships no 32-bit ARM engine, and its engine links
against OpenSSL 3, so Bullseye installs fine and then fails to open the database.

**1. Prepare the Pi.** Flash 64-bit Raspberry Pi OS Lite, enable SSH, and give it a
DHCP reservation in your router.

**2. Mount the drive for the database.** Find it, give it a filesystem if it needs
one, and mount it by UUID so it survives being unplugged and replugged:

```bash
lsblk -o NAME,SIZE,FSTYPE,UUID
sudo mkdir -p /mnt/data
echo "UUID=<uuid> /mnt/data ext4 defaults,nofail,noatime 0 2" | sudo tee -a /etc/fstab
sudo mount -a && df -h /mnt/data
```

`nofail` matters: without it, a Pi with the drive unplugged drops to an emergency
prompt instead of booting. `noatime` stops a read from causing a write.

**3. Build on your workstation and copy it over.** Building on the Pi takes minutes
and produces the same bytes:

```bash
node packaging/build.mjs arm64
scp -r packaging/out/arm64 solar@raspberrypi.local:/tmp/solar-dashboard
```

**4. Install.** Pass the mount point so the database goes on the drive and systemd
learns to wait for it:

```bash
ssh solar@raspberrypi.local
cd /tmp/solar-dashboard && sudo ./service/install.sh /mnt/data
```

It creates the `solar` service user, writes `/opt/solar-dashboard/.env` with your
timezone already filled in from the Pi, and starts on boot.

**5. Set it up** at `http://solar-dashboard.local:3001`. Note the port — there is no
Docker mapping here, so it is 3001 rather than 8080.

Two things start working that never could in a container: **Tuya plugs and HomeKit
pairing**. Both rely on devices announcing themselves to the local network, and a
Docker bridge does not carry those announcements. On the Pi they arrive.

### Moving an existing install across

Do this before decommissioning the old one, and check the numbers rather than
assuming.

```bash
# On the old machine — take a fresh backup and find it
curl -X POST http://localhost:8080/api/backup/run
ls -t backups/ | head -1

# Copy it over
scp backups/solar-<newest>.db solar@raspberrypi.local:/tmp/

# On the Pi — stop, replace, start
sudo systemctl stop solar-dashboard
sudo cp /tmp/solar-<newest>.db /mnt/data/solar.db
sudo chown solar:solar /mnt/data/solar.db
sudo systemctl start solar-dashboard
```

Then confirm it actually arrived. Lifetime energy and device count should match the
old install exactly:

```bash
curl -s http://solar-dashboard.local:3001/api/energy | head -c 200
curl -s http://solar-dashboard.local:3001/api/devices | grep -o '"id"' | wc -l
```

Only once those agree, turn the old one off:

```bash
docker compose down          # on the old machine
```

Keep the old `backups/` folder somewhere until you have a few days of clean history
on the Pi. It costs nothing and it is the only copy of everything before the move.

### Updating it

One command from your workstation:

```bash
scripts/deploy-pi.sh solar@solar-dashboard.local
```

It builds the arm64 bundle here, **asks the running app for a backup first**, stops
the service, copies the new files, restarts, and waits for the app to actually answer
`/api/status` before reporting success — a unit reports "started" the moment the
process spawns, which is well before it can serve. If it does not come up, the script
prints the last 40 log lines instead of claiming victory.

Then it does the check that matters: it compares the commit it just built against the
commit the running app reports, and **exits non-zero if they differ**. "The service
restarted" is not evidence the new code is live — a failed copy or a stale binary all
survive a restart looking healthy. Every build stamps a `version.json` beside the
binary for exactly this, and `/api/status` reports it:

```bash
curl -s http://solar-dashboard.local:3001/api/status | head -c 120
# {"build":{"version":"0.1.0","commit":"cf8067e","builtAt":"...","stamped":true},...
```

`stamped: false` means the app could not find its stamp — a dev run, or a bundle built
before this existed. It says so rather than inventing a version number, because an
invented one gets trusted.

`data/`, `backups/` and `.env` are excluded from the copy. Your database, your
snapshots and your configuration are the install; everything else is replaceable.

### When an update is bad

Every deploy copies the outgoing build to `/opt/solar-dashboard.prev/` before
installing the new one, so going back needs nothing but the Pi:

```bash
scripts/deploy-pi.sh solar@solar-dashboard.local --rollback
```

No build, no bundle, no repo — the moment you need this is the moment something is
broken, so it depends on none of them. It stops the service, restores the previous
files, starts it, waits for an answer, and prints which build came back. If the previous
build does not come up either, you get the log rather than a success message.

The same three paths are excluded, so a rollback cannot take your readings with it. If
the bad build migrated the database, restore a snapshot from `backups/` too — the
deploy took one immediately before it, which is the reason it does that.

### Automatic updates

Off by default. Turn them on in **Settings → Updates**, which is the whole of the
user-facing part: a channel, a switch for whether installs happen by themselves, and
an hour for when they may.

Nothing installs until an update source is configured, in a root-owned file the app
cannot edit:

```bash
sudo nano /etc/solar-dashboard/update.conf
```

```sh
UPDATE_REPO=owner/name             # or UPDATE_FEED_URL, or UPDATE_FEED_DIR
MINISIGN_PUBKEY=RWQf6L...          # the public half of your signing key
DATA_DIR=/mnt/data
```

Needs `jq`, `curl` and `minisign`:

```bash
sudo apt install jq curl minisign
```

**An update never deletes your data.** Not on install, not on rollback, not when the
schema changes. `data/` and `backups/` are excluded from every file operation in
both directions, and the test suite fingerprints them before and after each scenario
rather than taking it on trust. Schema changes are handled by going forward — the app
applies pending migrations itself on start — so an upgrade migrates and carries on. A
rollback leaves the newer schema with older code on top, which is a compatibility
problem with a forward fix, never a reason to overwrite a database with a snapshot.

#### Why the app does not do the updating

The updater is a root-owned systemd timer, not part of the dashboard. It downloads a
binary from the internet and executes it as root; the dashboard is a network-facing
service running as an unprivileged user that cannot write `/opt` and cannot call
`systemctl`. Putting the two together would make any bug in the HTTP surface a path
to root on a machine sitting on your home network.

So the app checks the feed and shows what it finds, and can write a file naming a
version you clicked Install on. **That file carries a version and nothing else** — no
URL, no asset name. The updater resolves the feed from its own root-owned config and
refuses unless what it independently finds matches. A compromised app can at worst ask
for a real, signed release it was already going to be offered.

#### What makes a build acceptable

A [minisign](https://jedisct1.github.io/minisign/) signature over `SHA256SUMS`,
verified against `MINISIGN_PUBKEY`, plus a matching checksum for the bundle. A
checksum alone proves only that the file matches what the release page says, and
whoever publishes one publishes the other; the signing key lives somewhere CI cannot
reach, so a stolen publishing account is not enough on its own.

**No key configured means nothing installs automatically.** Not a warning — a refusal.

Then the install is health-gated: the service is restarted, and the app must answer
`/api/status` *reporting the commit that was just installed*. A restart is not
evidence — a failed copy or a stale binary survives one looking healthy. If it does not
answer, or answers as the wrong build, the previous install is restored from
`/opt/solar-dashboard.prev` automatically.

It also refuses to: replace a build with no version stamp (nothing to compare against),
install a version older than the one running, retry a version that already failed on
this machine, or offer a pre-release on the stable channel.

#### Publishing a release

Tag it. CI does the rest, up to the point where a human has to mean it:

```bash
npm version patch --no-git-tag-version   # or edit package.json
git commit -am "0.1.1" && git tag v0.1.1
git push origin v0.1.1
```

The release workflow refuses a tag that disagrees with `package.json` (a release
tagged v0.2.0 containing a build stamped 0.1.9 would install and then offer itself
again forever), runs the tests, builds all three targets, checks every bundle carries
a version stamp, packages them, **installs the artifact it just built using the real
updater**, and attaches everything to a **draft** release.

Then, on the machine holding the signing key:

```bash
gh release download v0.1.1 -p SHA256SUMS
minisign -Sm SHA256SUMS
gh release upload v0.1.1 SHA256SUMS.minisig
gh release edit v0.1.1 --draft=false
```

The draft is not a formality. GitHub does not serve drafts to unauthenticated callers,
which is what the updater is, so an unsigned release cannot reach any machine. Three
things would each have to fail before one could: the draft would have to be published,
GitHub would have to start serving drafts anonymously, and the updater would have to
stop requiring `SHA256SUMS.minisig`.

To build and sign entirely locally instead:

```bash
node packaging/build.mjs all
node packaging/release.mjs all
scripts/test-release-artifact.sh
minisign -Sm packaging/out/SHA256SUMS
```

#### On trusting the build

If CI builds and you sign, your signature says "I published this", not "I read this".
A compromised workflow could produce a backdoored binary and have it signed. That gap
cannot be closed by rebuilding locally and comparing, because `pkg` output is not
bit-for-bit reproducible — two builds of the same commit differ.

What closes it partway: the workflow attaches [build
provenance](https://docs.github.com/actions/security-guides/using-artifact-attestations),
a Sigstore-backed statement that these exact bytes came out of this workflow at this
commit. Anyone can check it:

```bash
gh attestation verify solar-dashboard-arm64.tar.gz -R frankaube/solar-dashboard
```

So the artifact is tied to a commit you can read, and the signature is tied to a person.
If you would rather not extend that trust to a CI runner at all, build locally with the
commands above — the release path does not require the workflow.

`release.mjs` cannot sign, by omission rather than oversight: the private key must not
be reachable by a build script, a CI job, or anything holding a token.

#### Testing it without a Pi

```bash
scripts/test-updater.sh
```

Runs the updater end to end in a throwaway Debian container against a real minisign
keypair, forcing each failure path in turn: a build that never comes up, one that comes
up as the wrong commit, a signature from the wrong key, a tampered bundle, no key at
all, an unstamped install, and a downgrade attempt. Needs Docker; needs no Pi, no
GitHub repository and no published release.

`UPDATE_FEED_DIR` is the same mechanism pointed at a directory, which is also how an
air-gapped install updates from a USB stick.

Once something has actually been packaged, the other half is checkable too:

```bash
scripts/test-release-artifact.sh
```

That one signs the real `SHA256SUMS` with a throwaway key and installs the real
tarball with the real updater. It exists because the suite above proves the updater's
logic against a fabricated bundle, and a fabricated bundle cannot have the failures that
matter here: an archive rooted at the wrong directory, a missing Prisma engine, a binary
that arrives without its executable bit, a stamp that disagrees with what is inside.

### Also

- **64-bit OS required.** The `arm64` target and the arm64 images both need it.
  Raspberry Pi OS (64-bit) or Ubuntu Server.
- Give the DTU a **DHCP reservation** in your router — its address is dynamic, and
  while the collector rediscovers it by serial, a fixed address saves a lot of noise.
- Avoid DTU firmware auto-updates. The local protocol is unofficial.

---

## Configuration

Most settings live in the app. These env vars pre-seed a fresh install — put them in
`.env` next to `docker-compose.yml`.

| Variable | Purpose | Default |
|---|---|---|
| `TESLAMATE_ENCRYPTION_KEY` | Encrypts Tesla tokens at rest | **required** for TeslaMate |
| `DTU_HOST`, `DTU_SERIAL` | Solar gateway (the scan finds it too) | — |
| `CHARGER_HOST` | Tesla Wall Connector | — |
| `SITE_LATITUDE`, `SITE_LONGITUDE` | Weather forecast location | unset = weather off |
| `POLL_INTERVAL_MS` | Solar poll interval — **keep ≥ 300000** | 300000 |
| `NOTIFY_WEBHOOK_URL` | ntfy topic or Discord webhook | off |
| `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` | Home Assistant discovery | off |
| `API_TOKEN` | Require `Authorization: Bearer` on writes | off |
| `POSTGRES_PASSWORD` | TeslaMate database password | `hoymiles_dev` |

With no location set the weather feature stays off rather than guessing. Someone
else's forecast is worse than none, because it looks like data.

Postgres is bound to `127.0.0.1` — it has a well-known default password, so it is
deliberately not reachable from the rest of your LAN.

---

## Backups

Settings → Backup writes a consistent copy of the whole database — readings, panel
layout, rates, alert history — on a schedule, keeping the last N.

Frequency runs from every 6 hours to every 30 days. Daily and longer also take a
preferred hour, in your local time, and default to 03:00 — without one the
schedule drifts to whatever moment you happened to press Save, which for most
people is the middle of the afternoon. Shorter intervals just count elapsed time;
an hour would mean nothing to them.

Nothing is scheduled with cron. The app checks every 15 minutes whether the last
*successful* backup is older than the interval, so a reboot or a redeploy cannot
silently end the schedule — at worst it delays a run by a quarter hour. A failed
attempt does not count as a run, so a destination that was unreachable at 03:00
is retried rather than shelved until tomorrow.

Three destinations:

- **A folder** — a USB disk, a NAS, or any share the host has mounted. In Docker
  the folder must also be mounted *into* the container, which is what `BACKUP_DIR`
  in `.env` does; it lands on `/backups` inside, so enter `/backups` in the form.
- **S3-compatible** — Backblaze B2, Wasabi, Cloudflare R2, MinIO or AWS.
- **Google Drive** — a folder in your own Drive, via an OAuth client you create.

Your keys stay on this machine and are used only to upload. Restoring is a file
copy: stop the stack, replace `solar.db` in the `solardata` volume with a backup,
start it again.

### Cloudflare R2 (the cheap default)

Fourteen daily snapshots is well under 100 MB, which fits inside R2's free tier
and stays there. Backblaze B2 and Wasabi work identically — only the endpoint
changes.

1. Cloudflare dashboard → **R2** → **Create bucket**, e.g. `solar-backups`.
2. **Manage R2 API Tokens** → create a token with **Object Read & Write**,
   scoped to that bucket. Copy the access key ID and secret — the secret is
   shown once.
3. Note the S3 endpoint on the bucket page:
   `https://<account-id>.r2.cloudflarestorage.com`.
4. Settings → Backup → **S3-compatible**. Endpoint as above, your bucket, region
   `auto`, the two keys, and any folder name you like. **Test destination**
   writes and deletes a marker file, so a green result means the credentials
   really can write.

### Google Drive

More setup than R2, because Drive has no static keys — it needs an OAuth client
that only you can create.

1. [console.cloud.google.com](https://console.cloud.google.com) → new project →
   **APIs & Services** → enable the **Google Drive API**.
2. **OAuth consent screen** → External. Add yourself as the only user.
   **Publish it to Production.** While it sits in Testing, Google revokes the
   authorisation after 7 days and your backups stop — the app names this
   specifically if it happens, but publishing avoids it. The app asks only for
   the `drive.file` scope, which is non-sensitive, so publishing does not put you
   through Google's verification review.
3. **Credentials** → Create OAuth client ID → **Web application**. Under
   *Authorised redirect URIs*, paste the URI the Backup card displays —
   `http://localhost:8080/api/backup/oauth/google/callback`.
4. Paste the client ID and secret into Settings → Backup → Google Drive, press
   **Save**, then **Connect Google Drive**.

Two constraints worth knowing before you start. Google only permits an insecure
redirect back to `localhost`, so the connect step has to happen on the machine
running the dashboard — from elsewhere, forward the port first
(`ssh -L 8080:localhost:8080 user@host`) and use `http://localhost:8080/settings`.
And `drive.file` means the app can only ever see files it created itself, so it
cannot read, list or delete anything else in your Drive — including a folder of
the same name you made by hand.

Two things it does **not** cover. TeslaMate keeps its own Postgres database in a
separate container, so vehicle history is not in these snapshots. And a backup
written to a folder on the same disk as the database survives a bad deploy but not
a dead drive — point it somewhere else.

### Filling a collection gap

The dashboard only records what it managed to poll. If the machine sleeps through
a sunrise, the day's kWh total survives — the gateway's counter is cumulative and
lives on the gateway — but the five-minute power history has a hole.

A vendor cloud export can fill it:

```bash
node scripts/import-cloud-readings.mjs export.tsv --date 2026-07-29 --zone America/Toronto --dry-run
```

Imported rows are stored with `source = 'cloud'`, never blended silently into
your own readings — the power API tags them, so a chart or an audit can always
tell which points the app actually observed. The import refuses to write where a
real reading already exists, so re-running it is a no-op rather than a duplicate,
and `--undo --date <date>` removes exactly what it added.

Energy for imported points is integrated from the export rather than taken from
it (the export carries power only), so every imported value sits below the
gateway's own daily counter and importing cannot inflate the day's total.

---

## Endpoints

- Dashboard — `http://localhost:8080`
- TeslaMate — `http://localhost:4000` (sign in with Tesla API tokens; use
  [tesla_auth](https://github.com/adriankumpf/tesla_auth) so your password never
  touches this stack)
- Health — `http://localhost:8080/api/status`
- Prometheus — `http://localhost:8080/api/metrics` (starter dashboard in `grafana/`)

---

## Development

```bash
pnpm install
docker compose up -d db
pnpm --dir apps/api dev
pnpm --dir apps/web dev
```

Dev UI on **:5173**, API on **:3001**. Stop the dockerised API first (`docker compose
stop api`) — both bind 3001. To develop the UI against the containerised API instead,
set `API_DEV_URL=http://localhost:8080`.

```bash
pnpm --dir apps/api test
pnpm --dir apps/web test
```

The tests concentrate on unit conversions and anything that fails silently. Energy
bugs are quiet: reading watt-minutes as watt-hours overstates by 60× and still plots a
believable curve, and a coil thermistor read as room temperature looks perfectly
reasonable. Both were real bugs here. Both now have tests.

The same rule decides what gets a comment: if being wrong would still *look* right,
it needs one. Most of the assertions here exist because something already went wrong
once — a Modbus read that exceeded the protocol's own limit, a battery parser
reporting a confident 0% for a device it did not understand, a signing routine that
happened to work for exactly one endpoint.

**Simulated devices earn their keep.** Fixtures only ever agree with whatever the
author already believed; pointing an adapter at a fake device that answers like real
hardware has repeatedly found what unit tests could not.

## Architecture

```
Inverter / meters / devices on the LAN
      │  local protocols — protobuf, HTTP, mDNS, SSE
      ▼
NestJS collector ──► SQLite (Prisma) ──► REST API ──► React + MUI + ECharts
```

- `apps/api` — collector behind a vendor-neutral `InverterDataSource` interface,
  device adapters behind `DeviceAdapter`, storage, REST API, alerting.
- `apps/web` — React + TypeScript frontend.
- Core data is a single SQLite file. Postgres exists only for TeslaMate.
