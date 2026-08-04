#!/bin/sh
# Install Solar Dashboard as a systemd service. Run from the unpacked folder, as root:
#
#   sudo ./service/install.sh                     # database beside the binary
#   sudo ./service/install.sh /mnt/data           # database on a mounted drive
#
# Works on x64 and Raspberry Pi 4/5. A 64-BIT OS IS REQUIRED — Prisma ships no 32-bit ARM
# engine — and its engine is built against OpenSSL 3, so Debian 12 / Raspberry Pi OS
# Bookworm or newer. On Bullseye (OpenSSL 1.1) this installs happily and then fails to open
# the database, which is a confusing way to find out.
set -e

INSTALL_DIR=/opt/solar-dashboard
DATA_DIR="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(dirname "$HERE")"

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo" >&2
  exit 1
fi

case "$(uname -m)" in
  aarch64 | arm64 | x86_64) ;;
  *)
    echo "unsupported architecture $(uname -m) — a 64-bit OS is required" >&2
    exit 1
    ;;
esac

id -u solar >/dev/null 2>&1 || useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin solar
mkdir -p "$INSTALL_DIR"

# Copy everything except what belongs to the install rather than the build. The previous
# version copied the whole folder, so re-running it could overwrite a live database — this
# is the difference between an installer and an updater, and it needs to be both.
for entry in "$SRC"/*; do
  name="$(basename "$entry")"
  [ "$name" = "service" ] && continue
  [ "$name" = "data" ] && continue
  cp -r "$entry" "$INSTALL_DIR/"
done
chmod +x "$INSTALL_DIR/solar-dashboard"
mkdir -p "$INSTALL_DIR/backups"

# The updater ships inside the install so that an update can replace it. Kept root-owned
# and not writable by the service user: it runs as root, so anything that can rewrite it
# owns the machine.
mkdir -p "$INSTALL_DIR/service"
cp "$HERE/update.sh" "$INSTALL_DIR/service/update.sh"
chmod 755 "$INSTALL_DIR/service/update.sh"

# The database. Kept off the boot medium when a drive is given, because this writes every
# five minutes forever and that is exactly what wears out an SD card.
if [ -n "$DATA_DIR" ]; then
  if [ ! -d "$DATA_DIR" ]; then
    echo "$DATA_DIR does not exist — mount the drive first, then re-run" >&2
    exit 1
  fi
  chown -R solar:solar "$DATA_DIR"
  echo "  database  -> $DATA_DIR"
else
  mkdir -p "$INSTALL_DIR/data"
  echo "  database  -> $INSTALL_DIR/data  (fine to start with; move it to a USB disk later)"
fi

# Config lives in a .env beside the binary, which the app reads on start. Written once and
# never overwritten, so re-running this cannot silently reset someone's install.
if [ ! -f "$INSTALL_DIR/.env" ]; then
  {
    echo "# Solar Dashboard configuration."
    echo "# Edit, then: sudo systemctl restart solar-dashboard"
    echo ""
    echo "# Where the database lives. Leave alone unless the drive moves."
    if [ -n "$DATA_DIR" ]; then
      echo "SOLAR_DATA_DIR=$DATA_DIR"
    else
      echo "#SOLAR_DATA_DIR=/mnt/data"
    fi
    echo ""
    echo "# Your solar gateway. Leave blank on first run — the setup wizard finds it."
    echo "DTU_HOST="
    echo ""
    echo "# Which calendar day a reading counts toward. WITHOUT THIS every daily total is"
    echo "# bucketed by UTC and \"today\" will not line up with your utility's day."
    echo "SITE_TIMEZONE=$(cat /etc/timezone 2>/dev/null || echo UTC)"
    echo ""
    echo "# Weather forecast. Unset means the feature stays off rather than guessing."
    echo "SITE_LATITUDE="
    echo "SITE_LONGITUDE="
    echo ""
    echo "# 5 min keeps a vendor cloud uplink alive; 30 s starves it."
    echo "POLL_INTERVAL_MS=300000"
    echo ""
    echo "# Optional."
    echo "#CHARGER_HOST="
    echo "#NOTIFY_WEBHOOK_URL="
    echo "#EVCC_URL=http://evcc.local:7070"
    echo "#OCPP_ENABLE=1"
  } >"$INSTALL_DIR/.env"
  echo "  config    -> $INSTALL_DIR/.env  (timezone taken from this machine)"
else
  echo "  config    -> $INSTALL_DIR/.env  (kept)"
fi

chown -R solar:solar "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/.env"

# The unit, plus a mount dependency when the database lives on a separate drive.
#
# Without RequiresMountsFor, systemd can start this before the USB disk is mounted. Prisma
# then creates a fresh empty database at what is about to become a mountpoint, the real one
# appears underneath it, and the dashboard comes up looking like it has lost two weeks of
# history. It has not — but you cannot tell that from the screen, which is worse.
cp "$HERE/solar-dashboard.service" /etc/systemd/system/
DROPIN=/etc/systemd/system/solar-dashboard.service.d
if [ -n "$DATA_DIR" ]; then
  # A drop-in rather than editing the shipped unit: it is the documented override
  # mechanism, it survives the unit being recopied by the next install, and it does not
  # depend on getting a sed expression right against a file this script also ships.
  mkdir -p "$DROPIN"
  printf '[Unit]\nRequiresMountsFor=%s\n' "$DATA_DIR" >"$DROPIN/mount.conf"
  echo "  boot      -> waits for $DATA_DIR to mount before starting"
else
  rm -f "$DROPIN/mount.conf"
fi
# Automatic updates.
#
# The config is root-owned and 0644 on purpose. It holds the feed location and the signing
# key, and the whole point of separating the updater from the app is that a compromised app
# cannot redirect what root downloads. If the service user could edit this, it could.
#
# Written once and never overwritten, so an update cannot reset somebody's channel — or
# their key.
UPDATE_CONF_DIR=/etc/solar-dashboard
mkdir -p "$UPDATE_CONF_DIR"
if [ ! -f "$UPDATE_CONF_DIR/update.conf" ]; then
  {
    echo "# Automatic updates. Root-owned by design: the app must not be able to edit this."
    echo "#"
    echo "# Choose ONE source. All three take the same GitHub-shaped releases.json."
    echo "#UPDATE_REPO=owner/name"
    echo "#UPDATE_FEED_URL=https://example.org/solar-dashboard/releases.json"
    echo "#UPDATE_FEED_DIR=/mnt/data/releases"
    echo ""
    echo "# The public half of the key that signs SHA256SUMS. WITHOUT THIS NOTHING IS"
    echo "# INSTALLED AUTOMATICALLY — a checksum alone only proves the file matches what the"
    echo "# release page says, and whoever publishes one publishes the other."
    echo "MINISIGN_PUBKEY="
    echo ""
    echo "# Where the database and the handoff files live. Must match the app's data dir."
    if [ -n "$DATA_DIR" ]; then
      echo "DATA_DIR=$DATA_DIR"
    else
      echo "DATA_DIR=$INSTALL_DIR/data"
    fi
  } >"$UPDATE_CONF_DIR/update.conf"
fi
chown root:root "$UPDATE_CONF_DIR/update.conf"
chmod 644 "$UPDATE_CONF_DIR/update.conf"

cp "$HERE/solar-dashboard-update.service" "$HERE/solar-dashboard-update.timer" /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now solar-dashboard
# The timer runs regardless; the script exits immediately unless a channel is chosen in the
# app. That way switching updates on is a click rather than an ssh session.
systemctl enable --now solar-dashboard-update.timer

missing=""
for tool in curl jq minisign; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo ""
  echo "  updates   -> needs:$missing"
  echo "               sudo apt install$missing"
fi

IP="$(hostname -I | awk '{print $1}')"
echo ""
echo "Installed and started."
echo "  http://$IP:3001"
echo "  http://solar-dashboard.local:3001   (the app advertises this itself)"
echo ""
echo "Next: open it and run the setup wizard."
echo "Logs: sudo journalctl -u solar-dashboard -f"
