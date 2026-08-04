#!/bin/sh
# Snapshot TeslaMate's Postgres alongside the dashboard's own backups.
#
#   sudo /opt/teslamate/backup.sh
#
# The app's backup system covers the solar database and nothing else — it speaks SQLite,
# and TeslaMate's history lives in a Postgres container it has no access to. So the
# vehicle data needs its own job, landing in the same directory on the same schedule, or
# it quietly ends up existing in exactly one place.
#
# Runs pg_dump inside the container rather than needing a Postgres client on the host, and
# writes a custom-format dump (-Fc) because that restores selectively and compresses,
# where plain SQL does neither.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/mnt/backups}"
CONTAINER="${CONTAINER:-teslamate-db-1}"
DB_USER="${DB_USER:-hoymiles}"
DB_NAME="${DB_NAME:-teslamate}"
# Matches the dashboard's own default, so both halves of the history age out together.
KEEP="${KEEP:-14}"

log() { echo "[teslamate-backup] $*"; }

command -v docker >/dev/null 2>&1 || { log "docker not installed — nothing to back up"; exit 0; }

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  # Not an error: TeslaMate is optional, and a machine without it should not have a timer
  # failing every night for something it was never asked to do.
  log "$CONTAINER is not running — skipping"
  exit 0
fi

[ -d "$BACKUP_DIR" ] || { log "$BACKUP_DIR does not exist"; exit 1; }
# A separate mount that failed to come up would otherwise get a dump written into the
# empty mountpoint underneath it, on the boot disk, silently.
if ! mountpoint -q "$BACKUP_DIR" 2>/dev/null; then
  log "warning: $BACKUP_DIR is not a mount point — writing to whatever holds it"
fi

STAMP="$(date +%Y%m%d-%H%M)"
OUT="$BACKUP_DIR/teslamate-$STAMP.dump"
TMP="/tmp/teslamate-$STAMP.dump"

log "dumping $DB_NAME"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f "$TMP"
docker cp "$CONTAINER:$TMP" "$OUT"
docker exec "$CONTAINER" rm -f "$TMP"

# Prove it is a dump rather than an empty file that happens to exist. A backup nobody
# checks is a guess, and this is the cheapest possible check.
if ! pg_restore -l "$OUT" >/dev/null 2>&1; then
  if command -v pg_restore >/dev/null 2>&1; then
    log "ERROR: $OUT is not a readable dump"
    rm -f "$OUT"
    exit 1
  fi
  # No pg_restore on the host: fall back to a size sanity check rather than claiming a
  # verification that did not happen.
  SIZE="$(stat -c %s "$OUT" 2>/dev/null || echo 0)"
  [ "$SIZE" -gt 10240 ] || { log "ERROR: $OUT is only $SIZE bytes"; rm -f "$OUT"; exit 1; }
  log "written ($SIZE bytes; pg_restore absent, size checked only)"
else
  log "written and verified: $OUT ($(du -h "$OUT" | cut -f1))"
fi

chown solar:solar "$OUT" 2>/dev/null || true

# Prune only after a successful write, never before — a failed dump must not also take
# the older copies with it.
COUNT="$(ls -1 "$BACKUP_DIR"/teslamate-*.dump 2>/dev/null | wc -l)"
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/teslamate-*.dump | tail -n +$((KEEP + 1)) | while read -r old; do
    log "pruning $(basename "$old")"
    rm -f "$old"
  done
fi

log "done: $COUNT dump(s) kept"
