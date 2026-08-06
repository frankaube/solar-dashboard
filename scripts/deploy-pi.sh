#!/usr/bin/env bash
#
# Build the arm64 Lite bundle here and push it to the Pi. This is the update mechanism.
#
#   scripts/deploy-pi.sh you@solar.local
#   scripts/deploy-pi.sh you@10.0.0.50 --no-build     # push what is already built
#   scripts/deploy-pi.sh you@10.0.0.50 --rollback     # go back to the previous build
#
# Built on the workstation rather than on the Pi on purpose: a Pi 4 takes several minutes
# to bundle this and the cross-target output is identical, so there is no reason to make
# the Pi do it. That also means an update is a file copy and a service restart, which is
# fast enough to do casually — the point of the exercise.
#
# WHAT IT WILL NOT TOUCH: data/ and .env on the Pi. Those are the install; everything else
# is replaceable. rsync is given an explicit exclude list rather than a whole-directory
# copy, because "deploy wiped my database" is the one failure that cannot be undone from
# here.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: $0 user@host [--no-build] [--rollback]" >&2
  exit 1
fi
shift || true

BUILD=1
ROLLBACK=0
for arg in "$@"; do
  [ "$arg" = "--no-build" ] && BUILD=0
  [ "$arg" = "--rollback" ] && ROLLBACK=1
done

# Rolling back has to be possible without a working toolchain, a network, or the repo —
# the moment you need it is the moment a build is broken. Every deploy leaves the previous
# install beside the current one, so going back is a local file move on the Pi.
if [ "$ROLLBACK" = "1" ]; then
  echo "==> rolling back to the previous build"
  ssh "$TARGET" '
    set -e
    if [ ! -d /opt/solar-dashboard.prev ]; then
      echo "no previous build kept on this machine — nothing to roll back to" >&2
      exit 1
    fi
    sudo systemctl stop solar-dashboard
    sudo rsync -a --delete --checksum \
      --exclude "data/" --exclude "backups/" --exclude ".env" \
      /opt/solar-dashboard.prev/ /opt/solar-dashboard/
    sudo chown -R solar:solar /opt/solar-dashboard
    sudo systemctl start solar-dashboard
  '
  # Same rule as a deploy: a restart is not evidence it works. Wait for it to answer, and
  # say which build came back so there is no doubt the rollback took.
  for i in $(seq 1 30); do
    RUNNING=$(ssh "$TARGET" "curl -fsS http://127.0.0.1:3001/api/status 2>/dev/null" || true)
    if [ -n "$RUNNING" ]; then
      BACK=$(printf '%s' "$RUNNING" | node -e "
        let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
          try { const b=JSON.parse(d).build ?? {}; process.stdout.write(\`\${b.version ?? '?'} (\${b.commit ?? 'unstamped'})\`); } catch { }
        });" 2>/dev/null || true)
      echo "==> rolled back to ${BACK:-an unidentified build}"
      exit 0
    fi
    sleep 1
  done

  echo "!! the previous build did not come up either. Recent log:" >&2
  ssh "$TARGET" "sudo journalctl -u solar-dashboard -n 40 --no-pager" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/packaging/out/arm64"
REMOTE_DIR=/opt/solar-dashboard

if [ "$BUILD" = "1" ]; then
  echo "==> building arm64 bundle"
  (cd "$ROOT" && node packaging/build.mjs arm64)
fi

# -f, not -x. A bundle built on Windows has no executable bit — the filesystem does not
# have the concept — so testing for one reports a perfectly good binary as missing. The
# Pi-side install chmods it anyway, which is where the bit actually has to exist.
if [ ! -f "$DIST/solar-dashboard" ]; then
  echo "no binary at $DIST/solar-dashboard — run without --no-build" >&2
  exit 1
fi

echo "==> checking the Pi is reachable"
ssh -o ConnectTimeout=10 "$TARGET" 'echo "    connected to $(hostname), $(uname -m)"'

# A backup before every deploy. Cheap, and the only thing standing between a bad build and
# two weeks of readings.
echo "==> asking the running app for a backup first"
ssh "$TARGET" 'curl -fsS -X POST http://127.0.0.1:3001/api/backup/run >/dev/null 2>&1 \
  && echo "    backup written" \
  || echo "    (no backup taken — app not running or no destination set)"'

# From here the service is down, so any failure has to bring it back. Without this a
# missing tool on the workstation left the dashboard stopped on the Pi — which is how this
# trap came to exist.
restore_on_failure() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "!! deploy failed (exit $status) — restarting whatever is installed" >&2
    ssh "$TARGET" "sudo systemctl start solar-dashboard" >/dev/null 2>&1 || true
  fi
}
trap restore_on_failure EXIT

echo "==> stopping the service"
ssh "$TARGET" "sudo systemctl stop solar-dashboard || true"

# Keep the outgoing build so --rollback has somewhere to go. data/, backups/ and .env are
# excluded: this is a copy of the code, not a second copy of the database — and not a second
# copy of the credentials either, since .env is the one file here with secrets in it.
echo "==> keeping the current build for rollback"
ssh "$TARGET" "
  if [ -f $REMOTE_DIR/solar-dashboard ]; then
    sudo rsync -a --delete --checksum \
      --exclude 'data/' --exclude 'backups/' --exclude '.env' \
      $REMOTE_DIR/ $REMOTE_DIR.prev/
    echo \"    previous build kept at $REMOTE_DIR.prev\"
  else
    echo '    nothing installed yet — no rollback point'
  fi"

echo "==> copying"
# service/ is copied too, not excluded: it holds update.sh, and an updater that can only be
# replaced by a fresh install is one that can never be fixed. rsync writes to a temp file
# and renames, so replacing the script while a copy of it is running is safe — the running
# shell keeps reading the old inode.
#
# rsync is not assumed to exist HERE. Git for Windows ships without it, and this script is
# run from a Windows workstation as often as not — where it failed after having already
# stopped the service, leaving the dashboard down. tar over ssh needs nothing but ssh, and
# the whole bundle is 93 MB, so the delta-transfer rsync would give us is not worth a
# dependency that silently breaks the deploy halfway through.
ssh "$TARGET" "rm -rf /tmp/solar-dashboard-new && mkdir -p /tmp/solar-dashboard-new"
if command -v rsync >/dev/null 2>&1; then
  rsync -az --delete \
    --exclude 'data/' \
    --exclude 'backups/' \
    --exclude '.env' \
    "$DIST/" "$TARGET:/tmp/solar-dashboard-new/"
else
  echo "    (no rsync here — streaming a tarball over ssh instead)"
  tar -czf - -C "$DIST" \
    --exclude=data --exclude=backups --exclude=.env . \
    | ssh "$TARGET" "tar -xzf - -C /tmp/solar-dashboard-new"
fi
# --checksum on the install step, not just -a.
#
# rsync's default quick check is size + mtime, and version.json is the same length in every
# build — a 7-character SHA and a fixed-width timestamp. So it can be judged "unchanged" and
# skipped, leaving the old stamp in place while the new binary lands beside it. That would
# make the verification below compare against a stale file and report a mismatch on a good
# deploy, or worse, agree with itself on a bad one. Reproduced in a container before fixing.
ssh "$TARGET" "sudo rsync -a --delete --checksum \
  --exclude 'data/' --exclude 'backups/' --exclude '.env' \
  /tmp/solar-dashboard-new/ $REMOTE_DIR/ \
  && sudo chown -R solar:solar $REMOTE_DIR \
  && sudo chmod +x $REMOTE_DIR/solar-dashboard \
  && rm -rf /tmp/solar-dashboard-new"

# Unit files, which live in /etc and are not what rsync above replaces.
#
# Without this a deploy could change a unit or add a timer and the machine would carry the
# new file around under /opt while running the old one — which is exactly how the watchdog
# work would have shipped switched off. Mirrors what update.sh does for released builds.
#
# Sent as a quoted heredoc rather than an escaped one-liner. Every $ in this block belongs
# to the remote shell, and getting one of them expanded locally instead is how the first
# attempt turned `$unit` into an empty string and silently copied nothing.
echo "==> syncing systemd units"
ssh "$TARGET" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -u
changed=0
for unit in "$REMOTE_DIR"/service/*.service "$REMOTE_DIR"/service/*.timer; do
  [ -f "$unit" ] || continue
  name="$(basename "$unit")"
  if ! sudo cmp -s "$unit" "/etc/systemd/system/$name"; then
    sudo cp "$unit" "/etc/systemd/system/$name"
    echo "    updated $name"
    changed=1
  fi
done
[ "$changed" = 1 ] && sudo systemctl daemon-reload
# Timers ship disabled; enabling here is what makes a new one start working on an existing
# box rather than only at the next fresh install, which on a long-lived Pi is never.
if [ -f /etc/systemd/system/solar-netwatch.timer ]; then
  sudo systemctl enable --now solar-netwatch.timer >/dev/null 2>&1
fi
if [ -e /dev/watchdog ] && [ ! -f /etc/systemd/system.conf.d/solar-watchdog.conf ]; then
  sudo mkdir -p /etc/systemd/system.conf.d
  printf '[Manager]\nRuntimeWatchdogSec=15\nRebootWatchdogSec=2min\n' \
    | sudo tee /etc/systemd/system.conf.d/solar-watchdog.conf >/dev/null
  echo '    enabled the hardware watchdog (takes effect at the next boot)'
fi
true
REMOTE

echo "==> starting"
ssh "$TARGET" "sudo systemctl start solar-dashboard"

# Wait for it to answer rather than declaring success on a systemctl exit code — the unit
# reports "started" the moment the process spawns, which is well before it can serve.
echo "==> waiting for it to answer"
# Read with sed, not node. $DIST is an MSYS path like /d/work/... which node on Windows
# cannot resolve, so require() threw, BUILT_COMMIT came out empty, and the verification
# below quietly downgraded itself to "nothing local to compare against" — the one step
# that exists to catch a bad deploy, skipping on the platform this is run from.
BUILT_COMMIT=$(grep -o '"commit"[[:space:]]*:[[:space:]]*"[^"]*"' "$DIST/version.json" 2>/dev/null | head -1 | cut -d'"' -f4)

for i in $(seq 1 30); do
  RUNNING=$(ssh "$TARGET" "curl -fsS http://127.0.0.1:3001/api/status 2>/dev/null" || true)
  if [ -n "$RUNNING" ]; then
    echo "    up after ${i}s"
    # Verify the machine is running what was just built.
    #
    # "The service restarted" is not evidence the new code is live — a stale binary, a
    # failed copy or a cached layer all survive a restart looking healthy. Comparing the
    # commit closes the loop, which is the whole reason the build stamps one.
    RUNNING_COMMIT=$(printf '%s' "$RUNNING" | node -e "
      let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
        try { process.stdout.write(JSON.parse(d).build?.commit ?? ''); } catch { }
      });" 2>/dev/null || true)
    if [ -z "$BUILT_COMMIT" ]; then
      echo "    running: ${RUNNING_COMMIT:-unstamped} (nothing local to compare against)"
    elif [ "$BUILT_COMMIT" = "$RUNNING_COMMIT" ]; then
      echo "    verified: running $RUNNING_COMMIT, which is what was built"
    else
      echo "!! MISMATCH: built $BUILT_COMMIT but the Pi reports '${RUNNING_COMMIT:-unstamped}'." >&2
      echo "   The old build is still live. Check the copy step before trusting this deploy." >&2
      exit 1
    fi
    HOST_IP=$(ssh "$TARGET" "hostname -I | awk '{print \$1}'")
    echo "==> done: http://${HOST_IP}:3001"
    trap - EXIT
    exit 0
  fi
  sleep 1
done

echo "!! it did not answer within 30s. Recent log:" >&2
ssh "$TARGET" "sudo journalctl -u solar-dashboard -n 40 --no-pager" >&2
exit 1
