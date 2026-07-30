#!/usr/bin/env bash
#
# Build the arm64 Lite bundle here and push it to the Pi. This is the update mechanism.
#
#   scripts/deploy-pi.sh solar@solar-dashboard.local
#   scripts/deploy-pi.sh solar@10.0.0.50 --no-build     # push what is already built
#   scripts/deploy-pi.sh solar@10.0.0.50 --rollback     # go back to the previous build
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

if [ ! -x "$DIST/solar-dashboard" ]; then
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
rsync -az --delete \
  --exclude 'data/' \
  --exclude 'backups/' \
  --exclude '.env' \
  "$DIST/" "$TARGET:/tmp/solar-dashboard-new/"
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

echo "==> starting"
ssh "$TARGET" "sudo systemctl start solar-dashboard"

# Wait for it to answer rather than declaring success on a systemctl exit code — the unit
# reports "started" the moment the process spawns, which is well before it can serve.
echo "==> waiting for it to answer"
BUILT_COMMIT=$(node -e "process.stdout.write(require('$DIST/version.json').commit ?? '')" 2>/dev/null || true)

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
    exit 0
  fi
  sleep 1
done

echo "!! it did not answer within 30s. Recent log:" >&2
ssh "$TARGET" "sudo journalctl -u solar-dashboard -n 40 --no-pager" >&2
exit 1
