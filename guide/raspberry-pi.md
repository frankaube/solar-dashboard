# Running it on a Raspberry Pi

Everything from choosing the storage to moving an existing install across, plus the
failures worth knowing about before you hit them.

[← back to the README](../README.md)

---

## Pick your path

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

TeslaMate is Elixir/Phoenix plus its own Postgres. **4 GB is enough** — a Pi 4 running
the dashboard, TeslaMate and Postgres together sits around 900 MB used, with most of the
board's memory still free. The earlier advice here said 8 GB; that was a guess, and
measuring it said otherwise.

**You do not have to choose between the two builds.** The Lite binary speaks Postgres and
reads `TESLAMATE_DATABASE_URL` at runtime, so the dashboard can run as a systemd service
while TeslaMate runs in Docker beside it — or on another machine entirely. See *Adding
TeslaMate to a Pi* below. Building the API image on the Pi itself is slow; consider building
on a desktop and pushing to a registry.

## ⚠️ Do not run this from an SD card

This app writes every five minutes, forever, and TeslaMate's Postgres writes more.
That workload kills SD cards — usually somewhere between six and eighteen months, and
always without warning.

**Boot from a USB SSD**, or an NVMe HAT on a Pi 5. This is the single most important
thing on this page for a Pi deployment; it is the difference between a monitor that
runs for years and one that silently dies next spring taking your history with it.

### Or: keep the OS on the card and move only the database

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
(see the [Backups guide](backups.md)) if the history matters to you.

> **Power.** A bus-powered 2.5" drive can pull 4–5 W spinning up, on top of the Pi's
> own 3–7 W. Kit power supplies are usually 15 W, and the surge is enough to brown out
> a Pi 4 — which is a bad thing to do to a database mid-write. Use a mains-powered
> drive or a powered USB hub. `dmesg | grep -i voltage` will tell you if it is
> happening; the on-screen lightning bolt only appears if you have a display attached.

Back up regardless — `scripts/backup.sh` on the Pi (`scripts/backup.ps1` on Windows).
Both take a consistent SQLite snapshot rather than copying a live file, dump
TeslaMate's Postgres, keep the newest 12, and carry a scheduling command in the header.

## Installing it, start to finish

Tested target: Raspberry Pi 4B, **64-bit Raspberry Pi OS Bookworm or newer**. Both
constraints are hard — Prisma ships no 32-bit ARM engine, and its engine links
against OpenSSL 3, so Bullseye installs fine and then fails to open the database.

**1. Prepare the Pi — no monitor or keyboard needed.** In Raspberry Pi Imager, choose
64-bit Raspberry Pi OS Lite, then open **Edit Settings** before writing: set the hostname,
your username, **public-key SSH** (paste your `id_ed25519.pub`), locale and timezone.
Write the card, boot it, and `ssh you@<hostname>.local`. Give it a DHCP reservation in
your router while you are there.

> **Do not call your login user `solar`.** The installer creates `solar` as a system
> account with no shell and no login — the unprivileged identity the service runs as, and
> the reason the network-facing app is nowhere near root. If `solar` already exists as a
> login user, the installer reuses it, and the service silently ends up running as a
> shell-enabled, SSH-reachable account instead. Pick any other name. It is chosen once, in
> the Imager, and awkward to change afterwards.

Set the timezone in the Imager rather than leaving it: `install.sh` reads
`/etc/timezone` to write `SITE_TIMEZONE`, and without it every daily total is bucketed
by UTC, so "today" will not line up with your utility's day.

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
scp -r packaging/out/arm64 you@solar.local:/tmp/solar-dashboard
```

**4. Install.** First the handful of tools the deploy script and updater need — Pi OS
Lite ships none of them:

```bash
sudo apt update && sudo apt install -y rsync jq curl minisign sqlite3
```

Then install, passing the mount point so the database goes on the drive and systemd
learns to wait for it. Note `sudo sh`, not `sudo ./` — a bundle copied from Windows
arrives without the executable bit, and `./service/install.sh` fails with permission
denied:

```bash
ssh you@solar.local
cd /tmp/solar-dashboard && sudo sh ./service/install.sh /mnt/data
```

It creates the `solar` service user, writes `/opt/solar-dashboard/.env` with your
timezone already filled in from the Pi, and starts on boot.

**5. Set it up** at `http://solar-dashboard.local:3001`. Note the port — there is no
Docker mapping here, so it is 3001 rather than 8080.

Two things start working that never could in a container: **Tuya plugs and HomeKit
pairing**. Both rely on devices announcing themselves to the local network, and a
Docker bridge does not carry those announcements. On the Pi they arrive.

## Moving an existing install across

Do this before decommissioning the old one, and check the numbers rather than assuming.
"The dashboard came up" is not evidence the history arrived — a brand new empty database
also comes up, looks right, and shows today's readings. The difference only appears in
the row counts, which is exactly what nobody looks at until a week later.

**The database is a SQLite file, but not one you can copy off the host.** Under Docker it
lives in a named volume, and it is being written to every five minutes. Ask the app for a
snapshot instead — that runs `VACUUM INTO`, which is consistent against a live database
in a way that copying the file is not:

```bash
curl -X POST http://localhost:8080/api/backup/run
ls -t backups/ | head -1
```

Record what is in it, so there is something to compare against afterwards:

```bash
DATABASE_URL="file:$PWD/backups/solar-<newest>.db" node apps/api/scripts/db-census.mjs
```

```json
{ "counts": { "portReading": 59736, "dtuReading": 1843, "device": 4, "...": "..." },
  "span": { "first": "2026-07-23T19:50:00.000Z", "days": 7 },
  "totalRows": 82857 }
```

Then copy it over and put it in place:

```bash
scp backups/solar-<newest>.db you@solar.local:/tmp/
```

```bash
ssh you@solar.local
sudo systemctl stop solar-dashboard
sudo cp /tmp/solar-<newest>.db /mnt/data/solar.db
sudo chown solar:solar /mnt/data/solar.db
sudo systemctl start solar-dashboard
```

**Migrations apply themselves on start**, including across this move. The Docker
deployment records them in `_prisma_migrations` (the Prisma CLI's table) while the Lite
build keeps its own `_lite_migrations`; a database arriving from Docker has the first and
not the second. The Lite runner adopts that history rather than replaying it — without
that it would read "nothing applied", start again at the first migration, and fail on
`table "Dtu" already exists` before the app was even created. The service would not
start, citing a table that is perfectly fine. Your data is never at risk in that failure,
but a monitor that will not boot is not much comfort. You should see:

```
adopted 10 migrations already applied by prisma migrate
```

Now confirm it actually arrived:

```bash
curl -s http://solar.local:3001/api/summary
```

```bash
ssh you@solar.local "sudo -u solar sqlite3 /mnt/data/solar.db 'SELECT COUNT(*) FROM PortReading'"
```

The count must match the census above. `panelsTotal` and `invertersTotal` in the summary
should match the old install too. Only once they agree, turn the old one off:

```bash
docker compose down
```

Keep the old `backups/` folder somewhere until you have a few days of clean history on
the Pi. It costs nothing and it is the only copy of everything before the move.

> **The vehicle log does not come with it.** TeslaMate is a separate Elixir application
> with its own Postgres, and the Lite build does not include it. Solar, devices, charger
> readings, settings and alerts all move; drives, battery percentage and range do not.
> Leave the Docker stack running if you want to keep that, or accept the gap.

## Updating it

One command from your workstation:

```bash
scripts/deploy-pi.sh you@solar.local
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

## When an update is bad

Every deploy copies the outgoing build to `/opt/solar-dashboard.prev/` before
installing the new one, so going back needs nothing but the Pi:

```bash
scripts/deploy-pi.sh you@solar.local --rollback
```

No build, no bundle, no repo — the moment you need this is the moment something is
broken, so it depends on none of them. It stops the service, restores the previous
files, starts it, waits for an answer, and prints which build came back. If the previous
build does not come up either, you get the log rather than a success message.

The same three paths are excluded, so a rollback cannot take your readings with it. If
the bad build migrated the database, restore a snapshot from `backups/` too — the
deploy took one immediately before it, which is the reason it does that.

## Adding TeslaMate to a Pi

The dashboard runs as a systemd service; TeslaMate needs Docker. They coexist happily —
the only thing they share is a database, which the dashboard reads over loopback.

**1. Docker**, from its own repository with a verified signature. Not `curl … | sh`:
that installs whatever the server returns, unverified, as root, on a machine whose whole
premise is that root only executes signed binaries.

```bash
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

**2. A stack of its own** in `/opt/teslamate` — `docker-compose.yml` with `db` and
`teslamate`, and a `.env` (mode 600) holding `TESLAMATE_ENCRYPTION_KEY` and
`POSTGRES_PASSWORD`. Bind Postgres to `127.0.0.1:5432`, never `0.0.0.0`: the
dashboard is on the same machine, and a database published on all interfaces sits in
front of every device on the network.

**Carry the encryption key across unchanged.** It encrypts the stored Tesla API tokens.
Keep it and the move is invisible; change it and you re-authenticate from scratch.

**3. Bring your history with you**, if you had TeslaMate elsewhere:

```bash
# on the old machine
docker exec <old-db> pg_dump -U hoymiles -d teslamate -Fc -f /tmp/teslamate.dump
docker cp <old-db>:/tmp/teslamate.dump ./teslamate.dump
scp teslamate.dump you@solar.local:/tmp/
```

```bash
# on the Pi, once db is healthy
cd /opt/teslamate && sudo docker compose up -d db
sudo docker cp /tmp/teslamate.dump teslamate-db-1:/tmp/
sudo docker exec teslamate-db-1 pg_restore -U hoymiles -d teslamate --no-owner --clean --if-exists /tmp/teslamate.dump
```

Then check the numbers rather than the dashboard, which looks equally healthy either way:

```bash
sudo docker exec teslamate-db-1 psql -U hoymiles -d teslamate -t -A -c "SELECT COUNT(*) FROM positions"
```

**4. Point the dashboard at it**, in `/opt/solar-dashboard/.env`:

```sh
TESLAMATE_DATABASE_URL=postgresql://hoymiles:<password>@127.0.0.1:5432/teslamate
```

`sudo systemctl restart solar-dashboard`, then `curl -s localhost:3001/api/charger/vehicle`
should name your car.

**5. Back it up.** The app's own backup covers the solar database and nothing else — it
speaks SQLite, and TeslaMate's history is in a Postgres container it cannot reach. Without
this step those drives exist in exactly one place:

```bash
sudo install -m 755 service/teslamate-backup.sh /opt/teslamate/backup.sh
sudo install -m 644 service/teslamate-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now teslamate-backup.timer
```

It dumps to the same directory on the same nightly cycle, keeps 14, verifies each dump
with `pg_restore -l` before pruning anything, and exits quietly on a machine that has no
TeslaMate rather than failing every night.

## Things that will bite you

Learned the hard way, on real hardware, in one afternoon.

**Device letters move.** Plug in a second USB device and your boot disk can go from
`sda` to `sdb` on the next boot. Nothing breaks, because Pi OS mounts root by PARTUUID
— but any `mkfs` or `fstab` line you wrote against a letter now points somewhere else.
Always identify a disk by UUID or serial, and check it is not the one holding `/` before
formatting it.

**`nofail` in fstab is not optional.** Without it, a Pi that boots with an external drive
unplugged drops to an emergency prompt instead of starting. The dashboard matters more
than the drive holding its backups.

**A bus-powered 2.5" drive can reboot the board.** Spin-up pulls close to an amp on top of
the Pi's own draw, and a Pi 4 browns out rather than throttling gracefully. If a drive
makes the machine reset, the fix is a powered hub or a 5.1 V / 3 A supply — not a
different filesystem. An SSD draws about 2 W with no spin-up surge and sidesteps it.

**`vcgencmd get_throttled` resets at boot.** Reading `0x0` right after a reboot tells
you nothing about the event that caused it. It is only evidence after a long uptime.

**Settings migrate, paths do not.** Moving a database from Docker brings its settings with
it — including the backup destination, which was a path inside the container. It will
report the last successful run from the old machine while every future run fails with
`EACCES`. Check `/api/backup/status` after any move, and take one real backup rather
than trusting the config.

## Automatic updates

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

### Why the app does not do the updating

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

### What makes a build acceptable

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

### Publishing a release

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

### On trusting the build

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

### Testing it without a Pi

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

## Also

- **64-bit OS required.** The `arm64` target and the arm64 images both need it.
  Raspberry Pi OS (64-bit) or Ubuntu Server.
- Give the DTU a **DHCP reservation** in your router — its address is dynamic, and
  while the collector rediscovers it by serial, a fixed address saves a lot of noise.
- Avoid DTU firmware auto-updates. The local protocol is unofficial.

---
