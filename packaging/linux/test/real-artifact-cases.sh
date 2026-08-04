#!/bin/bash
# Install a REAL release artifact with the REAL updater, against a REAL minisign key.
#
# Everything before this used a fabricated bundle. This uses the 36 MB tarball that
# packaging/release.mjs just produced, signs its actual SHA256SUMS, and drives update.sh
# through a full install and a full rollback. The binary is arm64 and will not execute on
# this runner — which does not matter, because the health check is stubbed and what is
# under test is the download, the signature, the unpack and the swap.
set -u

# Setup failures must be loud.
#
# These two were silenced and their exit status ignored, so an apt problem on a CI runner
# produced a wall of assertion failures with nothing pointing at the cause: no minisign
# means every signature check fails, no jq means every parse returns empty. The tests would
# report the product as broken when the container never got its tools.
NEEDED="jq minisign rsync curl"
if ! apt-get update -qq >/tmp/apt.log 2>&1; then
  echo "SETUP FAILED: apt-get update" >&2
  tail -20 /tmp/apt.log >&2
  exit 1
fi
if ! apt-get install -y -qq $NEEDED >>/tmp/apt.log 2>&1; then
  echo "SETUP FAILED: apt-get install $NEEDED" >&2
  tail -20 /tmp/apt.log >&2
  exit 1
fi
missing=""
for t in $NEEDED; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
if [ -n "$missing" ]; then
  echo "SETUP FAILED: installed without error but missing:$missing" >&2
  tail -20 /tmp/apt.log >&2
  exit 1
fi
echo "setup: $(for t in $NEEDED; do printf '%s ' "$t"; done)present"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi }
has()  { if echo "$2" | grep -qi "$3"; then ok "$1"; else bad "$1 (no /$3/ in: $2)"; fi }

mkdir -p /keys /feed
minisign -G -p /keys/pub.key -s /keys/sec.key -W >/dev/null 2>&1
PUBKEY=$(tail -1 /keys/pub.key)

# The real artifact, under the name this x86 runner will look for.
# Whatever was packaged, renamed to what this runner will ask for. The arch in the name is
# matched by the updater and is covered by the other suite; what matters here is that the
# bytes are a genuine release artifact.
SRC=$(ls /out/solar-dashboard-*.tar.gz | head -1)
cp "$SRC" /feed/solar-dashboard-x64.tar.gz
REAL_VERSION=$(tar -xzOf /feed/solar-dashboard-x64.tar.gz ./version.json | jq -r .version)
REAL_COMMIT=$(tar -xzOf /feed/solar-dashboard-x64.tar.gz ./version.json | jq -r .commit)
echo "artifact: $(basename "$SRC")  $(du -h /feed/solar-dashboard-x64.tar.gz | cut -f1)  version $REAL_VERSION  commit $REAL_COMMIT"

(cd /feed && sha256sum solar-dashboard-x64.tar.gz > SHA256SUMS)
(cd /feed && minisign -Sm SHA256SUMS -s /keys/sec.key >/dev/null 2>&1)
cat > /feed/releases.json <<EOJ
[{"tag_name":"v$REAL_VERSION","published_at":"2026-08-01T00:00:00Z",
  "assets":[{"name":"solar-dashboard-x64.tar.gz","browser_download_url":"solar-dashboard-x64.tar.gz","size":37687543},
            {"name":"SHA256SUMS","browser_download_url":"SHA256SUMS","size":100},
            {"name":"SHA256SUMS.minisig","browser_download_url":"SHA256SUMS.minisig","size":200}]}]
EOJ

# stubbed systemctl / health endpoint
mkdir -p /stub
cat >/stub/systemctl <<'EOS'
#!/bin/sh
echo "systemctl $*" >> /tmp/systemctl.log
if [ "$1" = "start" ]; then
  if [ "$(cat /tmp/health-mode 2>/dev/null)" = "dead" ]; then rm -f /tmp/status.json; else
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

# An install one version behind, holding data that must survive.
setup() {
  rm -rf /opt/solar-dashboard /opt/solar-dashboard.prev /tmp/systemctl.log /tmp/status.json
  mkdir -p /opt/solar-dashboard/data /opt/solar-dashboard/backups /opt/solar-dashboard/service
  echo "old binary" > /opt/solar-dashboard/solar-dashboard
  printf '{"version":"0.0.9","commit":"0000000"}\n' > /opt/solar-dashboard/version.json
  echo "DTU_HOST=10.0.0.213" > /opt/solar-dashboard/.env
  echo "two years of readings" > /opt/solar-dashboard/data/solar.db
  echo "snapshot" > /opt/solar-dashboard/backups/solar-1.db
  cp /repo/update.sh /opt/solar-dashboard/service/update.sh
  chmod +x /opt/solar-dashboard/service/update.sh
  echo normal > /tmp/health-mode
  mkdir -p /etc/solar-dashboard
  cat > /etc/solar-dashboard/update.conf <<EOC
UPDATE_FEED_DIR=/feed
MINISIGN_PUBKEY=$PUBKEY
DATA_DIR=/opt/solar-dashboard/data
HEALTH_URL=file:///tmp/status.json
EOC
  printf '{"channel":"stable","apply":false,"hour":3}\n' > /opt/solar-dashboard/data/update-policy.json
  printf '{"version":"%s","requestedAt":"now"}\n' "$REAL_VERSION" > /opt/solar-dashboard/data/update-request.json
}
state() { jq -r "$1 // \"\"" /opt/solar-dashboard/data/update-state.json 2>/dev/null; }

echo ""
echo "== installing the real artifact =="
setup
BEFORE=$(find /opt/solar-dashboard/data /opt/solar-dashboard/backups -type f ! -name 'update-*' -exec sha256sum {} \; | sort)
OUT=$(/opt/solar-dashboard/service/update.sh 2>&1); RC=$?
echo "$OUT" | sed 's/^/    /'
check "exit 0" "$RC" "0"
check "version installed" "$(jq -r .version /opt/solar-dashboard/version.json)" "$REAL_VERSION"
check "commit installed" "$(jq -r .commit /opt/solar-dashboard/version.json)" "$REAL_COMMIT"
check "result ok" "$(state .result)" "ok"
check "the real binary landed" "$([ -s /opt/solar-dashboard/solar-dashboard ] && echo yes)" "yes"
check "binary is executable" "$([ -x /opt/solar-dashboard/solar-dashboard ] && echo yes)" "yes"
check "binary is the packaged one, not the placeholder" "$(head -c 4 /opt/solar-dashboard/solar-dashboard | od -An -c | tr -d ' ')" "177ELF"
check "web assets present" "$([ -d /opt/solar-dashboard/public ] && echo yes)" "yes"
check "prisma engine present" "$(ls /opt/solar-dashboard/engine | wc -l)" "1"
check "migrations shipped" "$([ -d /opt/solar-dashboard/migrations ] && echo yes)" "yes"
check "updater replaced itself" "$([ -f /opt/solar-dashboard/service/update.sh ] && echo yes)" "yes"
# systemd execs this directly. A bundle that ships it without the bit installs an updater
# that can never run again — the failure that made CI red and a Windows checkout hide it.
check "updater is executable" "$([ -x /opt/solar-dashboard/service/update.sh ] && echo yes || echo no)" "yes"
check "timer unit shipped" "$([ -f /opt/solar-dashboard/service/solar-dashboard-update.timer ] && echo yes)" "yes"
check "test suite NOT shipped" "$([ -d /opt/solar-dashboard/service/test ] && echo yes || echo no)" "no"
check "data untouched" "$(find /opt/solar-dashboard/data /opt/solar-dashboard/backups -type f ! -name 'update-*' -exec sha256sum {} \; | sort)" "$BEFORE"
check ".env untouched" "$(cat /opt/solar-dashboard/.env)" "DTU_HOST=10.0.0.213"

echo ""
echo "== a tampered real artifact is refused =="
setup
cp /feed/solar-dashboard-x64.tar.gz /feed/.keep
printf '\x00backdoor' >> /feed/solar-dashboard-x64.tar.gz
OUT=$(/opt/solar-dashboard/service/update.sh 2>&1)
has "checksum mismatch" "$OUT" "checksum mismatch"
check "still on 0.0.9" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.0.9"
mv /feed/.keep /feed/solar-dashboard-x64.tar.gz

echo ""
echo "== rollback from the real artifact =="
setup
echo dead > /tmp/health-mode
sed -i 's/^HEALTH_TIMEOUT=60/HEALTH_TIMEOUT=3/' /opt/solar-dashboard/service/update.sh
BEFORE=$(find /opt/solar-dashboard/data /opt/solar-dashboard/backups -type f ! -name 'update-*' -exec sha256sum {} \; | sort)
OUT=$(/opt/solar-dashboard/service/update.sh 2>&1); RC=$?
check "exit 1" "$RC" "1"
check "back on 0.0.9" "$(jq -r .version /opt/solar-dashboard/version.json)" "0.0.9"
check "result rolled-back" "$(state .result)" "rolled-back"
check "data untouched" "$(find /opt/solar-dashboard/data /opt/solar-dashboard/backups -type f ! -name 'update-*' -exec sha256sum {} \; | sort)" "$BEFORE"

echo ""
echo "================  $PASS passed, $FAIL failed  ================"
[ "$FAIL" = "0" ]
