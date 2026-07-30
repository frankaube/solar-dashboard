#!/bin/bash
# The updater's test suite. Runs inside a Debian container — see scripts/test-updater.sh.
#
# Exercises update.sh end to end against a real minisign key: a release is built, signed,
# published to a feed directory, and installed; then the failure paths that matter are
# forced one at a time (dead build, wrong build, wrong key, tampered bundle, no key,
# unstamped install, downgrade). systemctl and the health endpoint are stubbed so "the new
# build came up" and "it did not" are both reproducible.
set -u

apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq jq minisign rsync curl >/dev/null 2>&1

case "$(uname -m)" in aarch64|arm64) A=arm64 ;; *) A=x64 ;; esac
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi }
has()  { if echo "$2" | grep -qi "$3"; then ok "$1"; else bad "$1 (no /$3/ in: $2)"; fi }

# ---- signing key (throwaway, generated here, never leaves the container)
mkdir -p /keys
minisign -G -p /keys/pub.key -s /keys/sec.key -W >/dev/null 2>&1
PUBKEY=$(tail -1 /keys/pub.key)
# A second, unrelated key, to prove a wrong signature is actually rejected.
minisign -G -p /keys/other-pub.key -s /keys/other-sec.key -W >/dev/null 2>&1
OTHERPUB=$(tail -1 /keys/other-pub.key)

# ---- fake systemctl: records actions and simulates the service coming up
mkdir -p /stub
cat >/stub/systemctl <<'EOS'
#!/bin/sh
echo "systemctl $*" >> /tmp/systemctl.log
if [ "$1" = "start" ]; then
  # Coming up = publishing a status document with the commit of whatever is installed.
  if [ "$(cat /tmp/health-mode 2>/dev/null)" = "dead" ]; then
    rm -f /tmp/status.json
  elif [ "$(cat /tmp/health-mode 2>/dev/null)" = "wrong-build" ]; then
    echo '{"build":{"version":"?","commit":"deadbee","stamped":true}}' > /tmp/status.json
  else
    C=$(jq -r '.commit // empty' /opt/solar-dashboard/version.json 2>/dev/null)
    V=$(jq -r '.version // empty' /opt/solar-dashboard/version.json 2>/dev/null)
    echo "{\"build\":{\"version\":\"$V\",\"commit\":\"$C\",\"stamped\":true}}" > /tmp/status.json
  fi
fi
[ "$1" = "stop" ] && rm -f /tmp/status.json
exit 0
EOS
chmod +x /stub/systemctl
export PATH=/stub:$PATH
id -u solar >/dev/null 2>&1 || useradd --system solar

# ---- a published release: version 0.2.0, commit bbbbbbb
build_release() {
  ver="$1"; commit="$2"; dir=/build/$ver
  rm -rf "$dir"; mkdir -p "$dir/service"
  echo "#!/bin/sh" > "$dir/solar-dashboard"; chmod +x "$dir/solar-dashboard"
  printf '{"version":"%s","commit":"%s","builtAt":"2026-08-01T00:00:00Z"}\n' "$ver" "$commit" > "$dir/version.json"
  echo "asset for $ver" > "$dir/public-$ver.js"
  cp /repo/update.sh "$dir/service/update.sh"
  tar -czf "/feed/solar-dashboard-$A.tar.gz" -C "$dir" .
}

publish_feed() {
  ver="$1"; pre="${2:-false}"
  (cd /feed && sha256sum solar-dashboard-$A.tar.gz > SHA256SUMS)
  (cd /feed && rm -f SHA256SUMS.minisig && minisign -Sm SHA256SUMS -s /keys/sec.key >/dev/null 2>&1)
  cat > /feed/releases.json <<EOJ
[{"tag_name":"v$ver","prerelease":$pre,"published_at":"2026-08-01T00:00:00Z",
  "assets":[{"name":"solar-dashboard-$A.tar.gz","browser_download_url":"solar-dashboard-$A.tar.gz","size":512},
            {"name":"SHA256SUMS","browser_download_url":"SHA256SUMS","size":100},
            {"name":"SHA256SUMS.minisig","browser_download_url":"SHA256SUMS.minisig","size":200}]}]
EOJ
}

# ---- an install: 0.1.0 / aaaaaaa, with data that must survive everything
reset_install() {
  rm -rf /opt/solar-dashboard /opt/solar-dashboard.prev /tmp/systemctl.log /tmp/status.json
  mkdir -p /opt/solar-dashboard/data /opt/solar-dashboard/backups /opt/solar-dashboard/service
  echo "#!/bin/sh" > /opt/solar-dashboard/solar-dashboard; chmod +x /opt/solar-dashboard/solar-dashboard
  printf '{"version":"0.1.0","commit":"aaaaaaa","builtAt":"2026-07-30T00:00:00Z"}\n' > /opt/solar-dashboard/version.json
  echo "asset for 0.1.0" > /opt/solar-dashboard/public-0.1.0.js
  echo "DTU_HOST=10.0.0.213" > /opt/solar-dashboard/.env
  echo "two weeks of readings" > /opt/solar-dashboard/data/solar.db
  echo "snapshot" > /opt/solar-dashboard/backups/solar-1.db
  cp /repo/update.sh /opt/solar-dashboard/service/update.sh
  chmod +x /opt/solar-dashboard/service/update.sh
  echo normal > /tmp/health-mode
}

conf() {
  mkdir -p /etc/solar-dashboard
  cat > /etc/solar-dashboard/update.conf <<EOC
UPDATE_FEED_DIR=/feed
MINISIGN_PUBKEY=${1-$PUBKEY}
DATA_DIR=/opt/solar-dashboard/data
HEALTH_URL=file:///tmp/status.json
EOC
}

policy() { printf '{"channel":"%s","apply":%s,"hour":%s}\n' "$1" "$2" "${3:-3}" > /opt/solar-dashboard/data/update-policy.json; }
request(){ printf '{"version":"%s","requestedAt":"now"}\n' "$1" > /opt/solar-dashboard/data/update-request.json; }
state()  { jq -r "$1 // \"\"" /opt/solar-dashboard/data/update-state.json 2>/dev/null; }
run()    { /opt/solar-dashboard/service/update.sh "$@" 2>&1; }

mkdir -p /feed /build
build_release 0.2.0 bbbbbbb
publish_feed 0.2.0

echo "== 1. channel off does nothing, not even a check =="
reset_install; conf; policy off false
OUT=$(run); check "exits quietly" "$?" "0"
has "says the channel is off" "$OUT" "channel is off"
check "no state file written" "$([ -f /opt/solar-dashboard/data/update-state.json ] && echo yes || echo no)" "no"
check "version untouched" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"

echo "== 2. notify-only finds the release but installs nothing =="
reset_install; conf; policy stable false
OUT=$(run)
has "reports what is available" "$OUT" "available: 0.2.0"
check "still on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"
check "recorded as refused" "$(state .result)" "refused"
has "explains why" "$(state .message)" "not installed"

echo "== 3. outside the install window it only checks =="
reset_install; conf
NOW=$(date +%-H); WINDOW=$(( (NOW + 5) % 24 ))
policy stable true $WINDOW
OUT=$(run)
has "names the window" "$OUT" "outside the"
check "still on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"

echo "== 4. a user request installs it, window or not =="
reset_install; conf; policy stable false; request 0.2.0
OUT=$(run); RC=$?
check "succeeds" "$RC" "0"
check "now on 0.2.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.2.0"
check "commit advanced" "$(jq -r .commit /opt/solar-dashboard/version.json)" "bbbbbbb"
check "result ok" "$(state .result)" "ok"
check "recorded where it came from" "$(state .fromVersion)" "0.1.0"
check "database survived" "$(cat /opt/solar-dashboard/data/solar.db)" "two weeks of readings"
check ".env survived" "$(cat /opt/solar-dashboard/.env)" "DTU_HOST=10.0.0.213"
check "backups survived" "$(cat /opt/solar-dashboard/backups/solar-1.db)" "snapshot"
check "old asset removed" "$([ -f /opt/solar-dashboard/public-0.1.0.js ] && echo yes || echo no)" "no"
check "new asset present" "$([ -f /opt/solar-dashboard/public-0.2.0.js ] && echo yes || echo no)" "yes"
check "rollback point kept" "$(jq -r .version /opt/solar-dashboard.prev/version.json)" "0.1.0"
check "rollback point has no .env" "$([ -f /opt/solar-dashboard.prev/.env ] && echo yes || echo no)" "no"
check "request consumed" "$([ -f /opt/solar-dashboard/data/update-request.json ] && echo yes || echo no)" "no"
check "service was restarted" "$(grep -c 'systemctl start' /tmp/systemctl.log)" "1"

echo "== 5. running the same version again is a no-op =="
OUT=$(run --now)
has "says up to date" "$OUT" "up to date"
check "still 0.2.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.2.0"

echo "== 6. auto-install inside the window =="
reset_install; conf; policy stable true "$(date +%-H)"
OUT=$(run); check "succeeds" "$?" "0"
check "installed" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.2.0"
check "result ok" "$(state .result)" "ok"

echo "== 7. a build that does not come up is rolled back =="
reset_install; conf; policy stable false; request 0.2.0
echo dead > /tmp/health-mode
sed -i 's/^HEALTH_TIMEOUT=60/HEALTH_TIMEOUT=3/' /opt/solar-dashboard/service/update.sh
OUT=$(run); RC=$?
check "exits non-zero" "$RC" "1"
check "back on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"
check "commit back to aaaaaaa" "$(jq -r .commit /opt/solar-dashboard/version.json)" "aaaaaaa"
check "old asset restored" "$([ -f /opt/solar-dashboard/public-0.1.0.js ] && echo yes || echo no)" "yes"
check "new asset gone" "$([ -f /opt/solar-dashboard/public-0.2.0.js ] && echo yes || echo no)" "no"
check "result rolled-back" "$(state .result)" "rolled-back"
has "states the data was not touched" "$(state .message)" "data was not touched"
check "database still intact" "$(cat /opt/solar-dashboard/data/solar.db)" "two weeks of readings"
check ".env still intact" "$(cat /opt/solar-dashboard/.env)" "DTU_HOST=10.0.0.213"

echo "== 8. a build that answers as the WRONG commit is rolled back too =="
reset_install; conf; policy stable false; request 0.2.0
echo wrong-build > /tmp/health-mode
sed -i 's/^HEALTH_TIMEOUT=60/HEALTH_TIMEOUT=3/' /opt/solar-dashboard/service/update.sh
OUT=$(run); RC=$?
has "notices the mismatch" "$OUT" "expected"
check "exits non-zero" "$RC" "1"
check "back on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"

echo "== 9. a failed version is not retried automatically =="
# state now says 0.2.0 rolled back; an unattended run must leave it alone
conf; policy stable true "$(date +%-H)"
echo normal > /tmp/health-mode
OUT=$(run)
has "says it already failed" "$OUT" "already failed"
check "still on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"
echo "   ...but an explicit request overrides it"
request 0.2.0
OUT=$(run)
check "installs when asked" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.2.0"

echo "== 10. a signature from the wrong key is refused =="
reset_install; conf "$OTHERPUB"; policy stable false; request 0.2.0
OUT=$(run); RC=$?
has "says verification failed" "$OUT" "SIGNATURE VERIFICATION FAILED"
check "exits non-zero" "$RC" "1"
check "still on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"
check "result refused" "$(state .result)" "refused"
has "message names tampering or key mismatch" "$(state .message)" "tampered"
check "nothing was even stopped" "$([ -f /tmp/systemctl.log ] && echo yes || echo no)" "no"

echo "== 11. a tampered bundle is refused even with a valid signature =="
reset_install; conf; policy stable false; request 0.2.0
cp /feed/solar-dashboard-$A.tar.gz /feed/.keep
echo "malicious payload" >> /feed/solar-dashboard-$A.tar.gz   # signature still covers the OLD checksums
OUT=$(run); RC=$?
has "reports a checksum mismatch" "$OUT" "checksum mismatch"
check "still on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"
mv /feed/.keep /feed/solar-dashboard-$A.tar.gz

echo "== 12. no key configured means no automatic install =="
reset_install; conf ""; policy stable false; request 0.2.0
OUT=$(run)
has "says no key" "$OUT" "refusing to install an unverifiable build"
check "still on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"
check "result refused" "$(state .result)" "refused"

echo "== 13. a request for a version the feed does not offer is refused =="
reset_install; conf; policy stable false; request 9.9.9
OUT=$(run)
has "names the mismatch" "$OUT" "refusing"
check "still on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"
check "result refused" "$(state .result)" "refused"
check "request discarded" "$([ -f /opt/solar-dashboard/data/update-request.json ] && echo yes || echo no)" "no"

echo "== 14. an unstamped install is never replaced =="
reset_install; conf; policy stable true "$(date +%-H)"
rm -f /opt/solar-dashboard/version.json
OUT=$(run)
has "says it cannot identify the build" "$OUT" "cannot identify"
check "binary untouched" "$([ -f /opt/solar-dashboard/public-0.1.0.js ] && echo yes || echo no)" "yes"
check "result refused" "$(state .result)" "refused"

echo "== 15. a prerelease is invisible on the stable channel =="
build_release 0.3.0-rc.1 ccccccc
publish_feed 0.3.0-rc.1 true
reset_install; conf; policy stable true "$(date +%-H)"
OUT=$(run)
has "finds nothing usable" "$OUT" "no usable releases"
check "still on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"
echo "   ...but is offered on the prerelease channel"
policy prerelease false; request 0.3.0-rc.1
OUT=$(run)
check "installs the rc" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.3.0-rc.1"

echo "== 16. it never downgrades =="
build_release 0.0.9 ddddddd
publish_feed 0.0.9
reset_install; conf; policy stable true "$(date +%-H)"
OUT=$(run)
has "says up to date" "$OUT" "up to date"
check "still on 0.1.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"

echo "== 17. 0.10.0 outranks 0.9.0 (the ordering that string compare gets wrong) =="
build_release 0.10.0 eeeeeee
publish_feed 0.10.0
reset_install; conf
printf '{"version":"0.9.0","commit":"fff0000"}\n' > /opt/solar-dashboard/version.json
policy stable false; request 0.10.0
OUT=$(run)
check "installs 0.10.0 over 0.9.0" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.10.0"


echo "== 18. DATA IS NEVER DELETED — every path, including a schema change =="
# The invariant, checked rather than asserted: fingerprint everything under data/ and
# backups/ before each scenario and demand it is byte-identical afterwards.
fingerprint() { find /opt/solar-dashboard/data /opt/solar-dashboard/backups -type f \
  ! -name 'update-*.json' -exec sha256sum {} \; 2>/dev/null | sort; }

# A release that ships MORE migrations than the install has — i.e. a schema change.
build_release_with_migrations() {
  ver="$1"; commit="$2"; extra="$3"; dir=/build/$ver
  rm -rf "$dir"; mkdir -p "$dir/service"
  echo "#!/bin/sh" > "$dir/solar-dashboard"; chmod +x "$dir/solar-dashboard"
  printf '{"version":"%s","commit":"%s"}\n' "$ver" "$commit" > "$dir/version.json"
  cp /repo/update.sh "$dir/service/update.sh"
  i=0; while [ "$i" -lt "$extra" ]; do
    mkdir -p "$dir/migrations/2026080${i}_change"; echo "ALTER TABLE x ADD COLUMN y;" > "$dir/migrations/2026080${i}_change/migration.sql"
    i=$((i+1))
  done
  tar -czf "/feed/solar-dashboard-$A.tar.gz" -C "$dir" .
}

seed_migrations() { mkdir -p /opt/solar-dashboard/migrations/20260701_init; }

# -- 18a. successful upgrade that changes the schema
reset_install; seed_migrations; conf; policy stable false
echo "irreplaceable readings" > /opt/solar-dashboard/data/solar.db
echo "months of history" > /opt/solar-dashboard/data/extra.db
BEFORE="$(fingerprint)"
build_release_with_migrations 0.4.0 fff1111 3; publish_feed 0.4.0
request 0.4.0; OUT=$(run)
check "upgrade succeeded" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.4.0"
check "data byte-identical after upgrade" "$(fingerprint)" "$BEFORE"
has "notes the migrations" "$OUT" "new migration"
has "state says data untouched" "$(state .message)" "data was not touched"
check "new migrations are present for the app to apply" "$(ls /opt/solar-dashboard/migrations | wc -l)" "3"

# -- 18b. rollback after a schema change
reset_install; seed_migrations; conf; policy stable false
echo "irreplaceable readings" > /opt/solar-dashboard/data/solar.db
echo "months of history" > /opt/solar-dashboard/data/extra.db
BEFORE="$(fingerprint)"
echo dead > /tmp/health-mode
sed -i 's/^HEALTH_TIMEOUT=60/HEALTH_TIMEOUT=3/' /opt/solar-dashboard/service/update.sh
request 0.4.0; OUT=$(run)
check "rolled back" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.1.0"
check "data byte-identical after rollback" "$(fingerprint)" "$BEFORE"
has "state says data untouched" "$(state .message)" "data was not touched"
has "names the schema drift instead of a restore" "$(state .message)" "newer schema"
if echo "$(state .message)" | grep -qi "restoring a backup"; then
  ok "tells you NOT to restore a backup"
else
  bad "should steer away from restoring a backup"
fi

# -- 18c. every refusal path leaves data alone
for mode in wrongkey nokey tampered nosuchversion; do
  reset_install; seed_migrations
  echo "irreplaceable readings" > /opt/solar-dashboard/data/solar.db
  BEFORE="$(fingerprint)"
  case "$mode" in
    wrongkey)       conf "$OTHERPUB"; policy stable false; request 0.4.0 ;;
    nokey)          conf "";          policy stable false; request 0.4.0 ;;
    tampered)       conf;             policy stable false; request 0.4.0
                    cp /feed/solar-dashboard-$A.tar.gz /feed/.keep
                    echo "payload" >> /feed/solar-dashboard-$A.tar.gz ;;
    nosuchversion)  conf;             policy stable false; request 9.9.9 ;;
  esac
  run >/dev/null 2>&1
  check "data untouched ($mode)" "$(fingerprint)" "$BEFORE"
  [ "$mode" = "tampered" ] && mv /feed/.keep /feed/solar-dashboard-$A.tar.gz
done

echo ""
echo "================  $PASS passed, $FAIL failed  ================"
[ "$FAIL" = "0" ]
