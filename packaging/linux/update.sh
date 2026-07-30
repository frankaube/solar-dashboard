#!/bin/sh
# The updater. Runs as root from a systemd timer; never invoked by the web app.
#
#   solar-dashboard-update            # honour the policy (unattended)
#   solar-dashboard-update --now      # ignore the time window, still honour the channel
#   solar-dashboard-update --check    # look and report, install nothing
#
# WHY THIS IS NOT IN THE APP
#
# This downloads a file from the internet and executes it as root. The dashboard is a
# network-facing service running as an unprivileged user that cannot write /opt and cannot
# call systemctl, and that separation is the entire security story. The app may write two
# files — a policy and a request naming a version — and read a third. It never downloads,
# never verifies, never installs.
#
# So a compromised app can, at worst, ask for a real signed release it was already going to
# be offered. It cannot choose what root downloads: the feed URL comes from a root-owned
# config file, and the signature is checked against a key in that same file.
#
# WHAT MAKES A BUILD ACCEPTABLE
#
# A minisign signature over SHA256SUMS, verified against the configured public key, and a
# matching sha256 for the bundle. A checksum alone proves only that the file matches what
# the release page says — the same account that publishes one publishes the other. The
# signing key lives somewhere CI cannot reach, so a stolen publishing account is not enough.
#
# No key configured means no automatic updates. Not "warn and continue".
#
# THE INVARIANT: AN UPDATE NEVER DELETES DATA. NOT ON INSTALL, NOT ON ROLLBACK, NOT ON A
# SCHEMA CHANGE, NOT EVER.
#
# data/ and backups/ are excluded from every rsync here, in both directions — and rsync's
# --delete does not remove excluded paths, which the test suite asserts rather than assumes.
# Nothing in this script drops a table, restores a snapshot over a live database, or removes
# a file under data/.
#
# Schema changes are handled by moving forward, not by reverting: the app applies pending
# migrations itself at boot, so an upgrade migrates and keeps going. A rollback therefore
# leaves the newer schema in place with older code on top. That is a compatibility problem,
# never a data-loss one, and the fix is to reinstall the newer build — not to overwrite the
# database with a snapshot, which would silently discard every reading taken since.
set -eu

CONF=/etc/solar-dashboard/update.conf
INSTALL_DIR=/opt/solar-dashboard
DATA_DIR="$INSTALL_DIR/data"
HEALTH_URL=http://127.0.0.1:3001/api/status
SERVICE=solar-dashboard
SERVICE_USER=solar
UPDATE_FEED_DIR=""
UPDATE_FEED_URL=""
UPDATE_REPO=""
MINISIGN_PUBKEY=""
# Seconds to wait for the new build to answer before calling it a failure. A Pi 4 cold-starts
# this in about eight; sixty leaves room for a slow disk and a migration.
HEALTH_TIMEOUT=60

MODE=policy
for arg in "$@"; do
  case "$arg" in
    --now) MODE=now ;;
    --check) MODE=check ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# An `[ -f x ] && . x` one-liner would be an AND-OR list whose overall status is 1 when the
# file is absent, and under `set -e` that exits — silently, with no message, on any machine
# that has not been configured yet.
if [ -f "$CONF" ]; then
  # shellcheck source=/dev/null
  . "$CONF"
fi

log() { echo "[update] $*"; }
die() { echo "[update] $*" >&2; exit 1; }

for tool in curl jq tar rsync sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed — cannot update safely"
done

STATE="$DATA_DIR/update-state.json"
POLICY="$DATA_DIR/update-policy.json"
REQUEST="$DATA_DIR/update-request.json"
WORK=""
# Must end in a success, always. An EXIT trap whose last command fails replaces the script's
# exit status with that failure — so `exit 0` after "the channel is off" was reporting 1 to
# systemd, which marks the unit failed for doing exactly what it was told.
cleanup() {
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  return 0
}
trap cleanup EXIT INT TERM

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Every exit that did something writes here, so the panel in the app can say what happened
# without the user reading journalctl at 7 AM.
record() {
  result="$1"; message="$2"; to="${3:-}"
  [ -d "$DATA_DIR" ] || return 0
  jq -n \
    --arg startedAt "${STARTED_AT:-}" --arg finishedAt "$(now_iso)" \
    --arg fromVersion "${FROM_VERSION:-}" --arg fromCommit "${FROM_COMMIT:-}" \
    --arg toVersion "$to" --arg result "$result" --arg message "$message" \
    --arg checkedAt "$(now_iso)" \
    '{startedAt:$startedAt, finishedAt:$finishedAt, fromVersion:$fromVersion,
      fromCommit:$fromCommit, toVersion:$toVersion, result:$result, message:$message,
      checkedAt:$checkedAt}' >"$STATE.tmp" 2>/dev/null || return 0
  mv "$STATE.tmp" "$STATE"
  chown "$SERVICE_USER:$SERVICE_USER" "$STATE" 2>/dev/null || true
}

# A check that found nothing is still worth recording — "last looked" is how you tell a
# working updater from one that has been silently failing for a month.
touch_checked() {
  [ -d "$DATA_DIR" ] || return 0
  if [ -f "$STATE" ]; then
    jq --arg checkedAt "$(now_iso)" '.checkedAt = $checkedAt' "$STATE" >"$STATE.tmp" 2>/dev/null \
      && mv "$STATE.tmp" "$STATE"
  else
    jq -n --arg checkedAt "$(now_iso)" '{checkedAt:$checkedAt, result:null}' >"$STATE" 2>/dev/null || true
  fi
  chown "$SERVICE_USER:$SERVICE_USER" "$STATE" 2>/dev/null || true
}

# `jq -r '.x // empty'` yields empty for a field that is literally `false`, because jq's //
# treats false the same as null. Fine for strings, a trap for booleans — so absence is
# tested explicitly rather than leaned on.
json_get() { jq -r "if $2 == null then \"\" else $2 end" "$1" 2>/dev/null || true; }

# ---------------------------------------------------------------- policy and consent

CHANNEL=off
APPLY=false
HOUR=3
if [ -f "$POLICY" ]; then
  CHANNEL="$(json_get "$POLICY" '.channel')"; [ -n "$CHANNEL" ] || CHANNEL=off
  APPLY="$(json_get "$POLICY" '.apply')"; [ "$APPLY" = "true" ] || APPLY=false
  HOUR="$(json_get "$POLICY" '.hour')"; case "$HOUR" in ''|*[!0-9]*) HOUR=3 ;; esac
fi

case "$CHANNEL" in
  stable|prerelease) ;;
  *) log "channel is off — not checking"; exit 0 ;;
esac

REQUESTED=""
[ -f "$REQUEST" ] && REQUESTED="$(json_get "$REQUEST" '.version')"

if [ "$MODE" = "policy" ] && [ -z "$REQUESTED" ]; then
  [ "$APPLY" = "true" ] || { log "notify-only and nothing requested — checking only"; MODE=check; }
  if [ "$MODE" != "check" ]; then
    # A two-hour window against an hourly timer. One hour would be a race with the timer's
    # own drift, and missing the slot means waiting a full day.
    CURRENT_HOUR="$(date +%-H)"
    END=$((HOUR + 2))
    if [ "$CURRENT_HOUR" -lt "$HOUR" ] || [ "$CURRENT_HOUR" -ge "$END" ]; then
      log "outside the ${HOUR}:00-${END}:00 window — checking only"
      MODE=check
    fi
  fi
fi

# ---------------------------------------------------------------- what is running

FROM_VERSION=""
FROM_COMMIT=""
if [ -f "$INSTALL_DIR/version.json" ]; then
  FROM_VERSION="$(json_get "$INSTALL_DIR/version.json" '.version')"
  FROM_COMMIT="$(json_get "$INSTALL_DIR/version.json" '.commit')"
fi
if [ -z "$FROM_VERSION" ]; then
  # The same rule the app applies: an unstamped build cannot be compared, so it is never
  # replaced automatically. Refusing is the conservative answer — this is somebody's own
  # build, and discarding it silently would be the worst outcome available.
  log "no version stamp in $INSTALL_DIR — refusing to update a build I cannot identify"
  record refused "The running build has no version stamp, so it cannot be compared to a release." ""
  exit 0
fi

case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
BUNDLE="solar-dashboard-$ARCH.tar.gz"

WORK="$(mktemp -d)"

# ---------------------------------------------------------------- the feed

fetch() {
  # $1 = asset name, $2 = destination
  if [ -n "$UPDATE_FEED_DIR" ]; then
    cp "$UPDATE_FEED_DIR/$1" "$2"
  else
    curl -fsSL --max-time 600 --retry 2 -o "$2" "$FEED_BASE/$1"
  fi
}

if [ -n "$UPDATE_FEED_DIR" ]; then
  cp "$UPDATE_FEED_DIR/releases.json" "$WORK/releases.json" \
    || die "no releases.json in $UPDATE_FEED_DIR"
elif [ -n "$UPDATE_FEED_URL" ]; then
  curl -fsSL --max-time 60 -H 'user-agent: solar-dashboard' -o "$WORK/releases.json" \
    "$UPDATE_FEED_URL" || die "could not read $UPDATE_FEED_URL"
elif [ -n "$UPDATE_REPO" ]; then
  curl -fsSL --max-time 60 -H 'user-agent: solar-dashboard' \
    -H 'accept: application/vnd.github+json' -o "$WORK/releases.json" \
    "https://api.github.com/repos/$UPDATE_REPO/releases?per_page=20" \
    || die "could not read GitHub releases for $UPDATE_REPO"
else
  log "no update source configured in $CONF"
  exit 0
fi

# Highest published version on this channel. Sorted by jq rather than by shell, because
# 0.10.0 must outrank 0.9.0 and string ordering gets that backwards.
ALLOW_PRE=false
[ "$CHANNEL" = "prerelease" ] && ALLOW_PRE=true
TARGET="$(jq -r --argjson pre "$ALLOW_PRE" '
  [ .[]
    | select(.draft != true)
    | select($pre or (.prerelease != true and ((.tag_name // "") | test("-") | not)))
    | (.tag_name // "") | sub("^v"; "")
    | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+"))
  ]
  | map({ v: ., k: [ (split("-")[0] | split(".") | map(tonumber)), (if test("-") then 1 else 0 end) ] })
  | sort_by(.k) | reverse | .[0].v // empty
' "$WORK/releases.json")"

if [ -z "$TARGET" ]; then
  log "no usable releases on the $CHANNEL channel"
  touch_checked
  exit 0
fi

newer() {
  # "is $1 strictly newer than $2", by numeric fields. A prerelease of the same numbers
  # ranks below the release, matching the app's comparison.
  [ "$1" = "$2" ] && return 1
  printf '%s\n%s\n' "$1" "$2" | jq -Rn '
    [inputs | { raw: ., n: (split("-")[0] | split(".") | map(tonumber)), pre: (if test("-") then 0 else 1 end) }]
    | if (.[0].n > .[1].n) or (.[0].n == .[1].n and .[0].pre > .[1].pre) then 0 else 1 end
  ' | grep -q '^0$'
}

if ! newer "$TARGET" "$FROM_VERSION"; then
  log "up to date on $FROM_VERSION (published: $TARGET)"
  touch_checked
  exit 0
fi

log "available: $TARGET (running $FROM_VERSION)"

if [ "$MODE" = "check" ]; then
  record refused "$TARGET is available but was not installed: nothing requested it and unattended installs are off or outside the window." "$TARGET"
  exit 0
fi

# The consent check. A queued request names the version the user actually saw, and it must
# match what this script independently resolved — the app does not get to name a target.
if [ -n "$REQUESTED" ] && [ "$REQUESTED" != "$TARGET" ]; then
  log "requested $REQUESTED but the feed offers $TARGET — refusing"
  record refused "A request for $REQUESTED did not match the published $TARGET. Nothing was installed." "$TARGET"
  rm -f "$REQUEST"
  exit 0
fi

# Do not reinstall a version that already failed here, unless a human asked again. Without
# this, one bad release installs and rolls back every single night, forever.
if [ -z "$REQUESTED" ] && [ -f "$STATE" ]; then
  LAST_RESULT="$(json_get "$STATE" '.result')"
  LAST_TO="$(json_get "$STATE" '.toVersion')"
  case "$LAST_RESULT" in
    rolled-back|failed)
      if [ "$LAST_TO" = "$TARGET" ]; then
        log "$TARGET already failed on this machine — not retrying automatically"
        touch_checked
        exit 0
      fi
      ;;
  esac
fi

# ---------------------------------------------------------------- download and verify

[ -n "$MINISIGN_PUBKEY" ] || {
  log "no MINISIGN_PUBKEY in $CONF — refusing to install an unverifiable build"
  record refused "No signing key is configured, so $TARGET cannot be verified. Install it manually or set MINISIGN_PUBKEY." "$TARGET"
  exit 0
}
command -v minisign >/dev/null 2>&1 || {
  record refused "minisign is not installed, so $TARGET cannot be verified." "$TARGET"
  die "minisign is not installed"
}

FEED_BASE=""
if [ -z "$UPDATE_FEED_DIR" ]; then
  FEED_BASE="$(jq -r --arg v "$TARGET" '
    .[] | select((.tag_name // "" | sub("^v";"")) == $v)
    | .assets[0].browser_download_url // empty' "$WORK/releases.json" \
    | head -1 | sed 's|/[^/]*$||')"
  [ -n "$FEED_BASE" ] || { record failed "Release $TARGET has no downloadable assets." "$TARGET"; die "no assets for $TARGET"; }
fi

STARTED_AT="$(now_iso)"

# Space first. Filling the disk mid-download is a worse failure than not updating, and on a
# Pi the bundle plus the extracted copy is most of a spare gigabyte.
FREE_KB="$(df -Pk "$INSTALL_DIR" | awk 'NR==2 {print $4}')"
if [ "${FREE_KB:-0}" -lt 1048576 ]; then
  record failed "Only $((FREE_KB / 1024)) MB free on the install disk; at least 1 GB is needed." "$TARGET"
  die "not enough free space"
fi

log "downloading $TARGET"
fetch "$BUNDLE" "$WORK/$BUNDLE" || { record failed "Could not download $BUNDLE." "$TARGET"; die "download failed"; }
fetch SHA256SUMS "$WORK/SHA256SUMS" || { record failed "Could not download SHA256SUMS." "$TARGET"; die "download failed"; }
fetch SHA256SUMS.minisig "$WORK/SHA256SUMS.minisig" || { record failed "Could not download the signature." "$TARGET"; die "download failed"; }

log "verifying signature"
if ! minisign -V -P "$MINISIGN_PUBKEY" -m "$WORK/SHA256SUMS" -x "$WORK/SHA256SUMS.minisig" >/dev/null 2>&1; then
  # The loud one. A bad signature is not a network hiccup: either the release was tampered
  # with or the key is wrong, and both need a human before anything else happens.
  log "SIGNATURE VERIFICATION FAILED for $TARGET — nothing installed"
  record refused "The signature on $TARGET did not verify against the configured key. Nothing was installed. This is either a tampered release or a key mismatch — do not install it manually until you know which." "$TARGET"
  exit 1
fi

log "verifying checksum"
if ! (cd "$WORK" && grep " $BUNDLE\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1); then
  record refused "The checksum for $BUNDLE did not match the signed SHA256SUMS." "$TARGET"
  die "checksum mismatch"
fi

# ---------------------------------------------------------------- install

mkdir -p "$WORK/staging"
tar -xzf "$WORK/$BUNDLE" -C "$WORK/staging" || { record failed "Could not unpack $BUNDLE." "$TARGET"; die "unpack failed"; }
# Bundles unpack into a single top-level directory; tolerate either shape.
SRC="$WORK/staging"
[ -f "$SRC/solar-dashboard" ] || SRC="$(find "$WORK/staging" -maxdepth 2 -name solar-dashboard -type f | head -1 | xargs dirname 2>/dev/null || true)"
[ -n "$SRC" ] && [ -f "$SRC/solar-dashboard" ] || { record failed "$BUNDLE does not contain a solar-dashboard binary." "$TARGET"; die "bad bundle"; }

EXPECT_COMMIT=""
[ -f "$SRC/version.json" ] && EXPECT_COMMIT="$(json_get "$SRC/version.json" '.commit')"

# Will this build change the schema?
#
# Counting the migration directories shipped in each bundle answers it without a database
# client, and it is the only thing that makes a rollback message useful: "old code, newer
# schema" is a specific, fixable situation, and it is worth naming instead of hinting at.
count_migrations() {
  [ -d "$1/migrations" ] || { echo 0; return; }
  find "$1/migrations" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' '
}
OLD_MIGRATIONS="$(count_migrations "$INSTALL_DIR")"
NEW_MIGRATIONS="$(count_migrations "$SRC")"
SCHEMA_NOTE=""
if [ "$NEW_MIGRATIONS" -gt "$OLD_MIGRATIONS" ]; then
  SCHEMA_NOTE=" $TARGET adds $((NEW_MIGRATIONS - OLD_MIGRATIONS)) migration(s), which the app applies itself on start."
  log "$TARGET ships $((NEW_MIGRATIONS - OLD_MIGRATIONS)) new migration(s)"
fi

# A snapshot before anything is replaced. Belt and braces, not the recovery plan: nothing
# below deletes data, so this exists for the case where something outside this script goes
# wrong, not as the thing that makes a rollback safe.
log "asking the app for a backup"
curl -fsS -X POST http://127.0.0.1:3001/api/backup/run >/dev/null 2>&1 \
  && BACKUP_NOTE="A snapshot was taken immediately before this update." \
  || BACKUP_NOTE="No pre-update snapshot was taken (the app did not answer or has no destination set)."

log "stopping $SERVICE"
systemctl stop "$SERVICE" || true

log "keeping the current build for rollback"
rsync -a --delete --checksum --exclude 'data/' --exclude 'backups/' --exclude '.env' \
  "$INSTALL_DIR/" "$INSTALL_DIR.prev/"

log "installing $TARGET"
# --checksum, not the default size+mtime quick check: version.json is the same length in
# every build, so it can be judged unchanged and skipped — leaving the old stamp beside the
# new binary and defeating the verification below.
rsync -a --delete --checksum --exclude 'data/' --exclude 'backups/' --exclude '.env' \
  "$SRC/" "$INSTALL_DIR/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/solar-dashboard"

log "starting $SERVICE"
systemctl start "$SERVICE"

# ---------------------------------------------------------------- health gate

healthy=0
i=0
while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
  BODY="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  if [ -n "$BODY" ]; then
    RUNNING_COMMIT="$(printf '%s' "$BODY" | jq -r '.build.commit // empty' 2>/dev/null || true)"
    if [ -z "$EXPECT_COMMIT" ] || [ "$RUNNING_COMMIT" = "$EXPECT_COMMIT" ]; then
      healthy=1
    else
      # It answered, but as the wrong build. A restart is not evidence the new code is live.
      log "answered as '$RUNNING_COMMIT' but expected '$EXPECT_COMMIT'"
    fi
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$healthy" = "1" ]; then
  log "updated to $TARGET"
  record ok "Your data was not touched.$SCHEMA_NOTE $BACKUP_NOTE" "$TARGET"
  rm -f "$REQUEST"
  exit 0
fi

# ---------------------------------------------------------------- rollback

log "$TARGET did not come up — rolling back to $FROM_VERSION"
systemctl stop "$SERVICE" || true
rsync -a --delete --checksum --exclude 'data/' --exclude 'backups/' --exclude '.env' \
  "$INSTALL_DIR.prev/" "$INSTALL_DIR/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
systemctl start "$SERVICE"

# The database is deliberately NOT restored, and that is the safe choice, not a shortcut.
#
# Restoring the snapshot would discard every reading collected since it was taken — real
# data, deleted automatically, at 3 AM, to fix a problem that may not exist. A rollback
# undoes code; it does not need to undo the database, because nothing here damaged it.
#
# What a rollback can leave behind is older code on a newer schema, when the failed build
# had already migrated. That is a compatibility problem with a forward fix, and the message
# says so rather than pointing at a restore.
if [ -n "$SCHEMA_NOTE" ]; then
  SCHEMA_WARNING=" $TARGET had already applied $((NEW_MIGRATIONS - OLD_MIGRATIONS)) migration(s), so $FROM_VERSION is now running against a newer schema. Your data is intact and nothing was deleted; if $FROM_VERSION misbehaves, install $TARGET or a later release rather than restoring a backup."
else
  SCHEMA_WARNING=" The database schema did not change."
fi
record rolled-back "$TARGET did not answer within ${HEALTH_TIMEOUT}s, so $FROM_VERSION was restored. Your data was not touched.$SCHEMA_WARNING $BACKUP_NOTE" "$TARGET"
rm -f "$REQUEST"
exit 1
