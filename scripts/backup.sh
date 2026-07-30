#!/usr/bin/env bash
#
# Back up the core SQLite database and the TeslaMate Postgres database.
# The POSIX twin of backup.ps1, for the Linux and Raspberry Pi deployments the
# README recommends — where a PowerShell script is of no use.
#
# Schedule weekly with cron, e.g. 03:00 on Sundays:
#   crontab -e
#   0 3 * * 0 /opt/hoymiles-dashboard/scripts/backup.sh >> /var/log/hoymiles-backup.log 2>&1
#
# Usage: backup.sh [output-directory]      (default: ~/backups/hoymiles)

set -euo pipefail

OUT_DIR="${1:-$HOME/backups/hoymiles}"
KEEP=12
API_CONTAINER="hoymiles-dashboard-api-1"
DB_CONTAINER="hoymiles-dashboard-db-1"

mkdir -p "$OUT_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"

# Core (SQLite). VACUUM INTO writes a consistent snapshot even while the collector
# is mid-write, which a plain file copy does not — copying a live SQLite file can
# capture a torn page and produce a backup that only fails when you try to restore it.
docker exec "$API_CONTAINER" node -e "const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient(); p.\$executeRawUnsafe(\`VACUUM INTO '/data/backup-tmp.db'\`).then(() => p.\$disconnect())"
docker cp "$API_CONTAINER:/data/backup-tmp.db" "$OUT_DIR/solar-$stamp.db"
docker exec "$API_CONTAINER" rm -f /data/backup-tmp.db

# TeslaMate (Postgres). Skipped rather than failed when the container is not running,
# because the lite deployment has no TeslaMate and should still back up its solar data.
if docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  container_path="/tmp/teslamate-$stamp.dump"
  docker exec "$DB_CONTAINER" pg_dump -U hoymiles -d teslamate -F c -f "$container_path"
  docker cp "$DB_CONTAINER:$container_path" "$OUT_DIR/teslamate-$stamp.dump"
  docker exec "$DB_CONTAINER" rm -f "$container_path"
else
  echo "note: $DB_CONTAINER not running — skipping TeslaMate dump"
fi

# Keep the newest $KEEP of each kind.
for pattern in 'solar-*.db' 'teslamate-*.dump'; do
  # -maxdepth 1 so a nested directory of old backups is never walked into.
  find "$OUT_DIR" -maxdepth 1 -name "$pattern" -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- |
    while read -r old; do rm -f "$old"; done
done

echo "backed up to $OUT_DIR (stamp $stamp)"
ls -lh "$OUT_DIR" | tail -n +2 | tail -4
