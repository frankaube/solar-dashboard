#!/bin/bash
# The network watchdog's test suite. Runs inside a container — see scripts/test-netwatch.sh.
#
# Everything the script can do is destructive to a running machine: it downs interfaces,
# unloads kernel modules and reboots. So `ip`, `modprobe`, `ping`, `systemctl` and `logger`
# are all stubbed here, and what is under test is the decision — how many failures before
# each step, that the steps escalate in order, and that a recovery is noticed and recorded.
#
# The case that matters most is the last one: a reboot must not re-arm itself. A box that
# reboots on every boot is worse than a box that is down, because it never stays up long
# enough for anyone to fix it remotely.
set -u

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi }
contains(){ if echo "$2" | grep -q "$3"; then ok "$1"; else bad "$1 (no '$3' in: $2)"; fi }

# The mount that carries netwatch.sh. Overridable so the suite can be run against a working
# copy outside the container.
ROOT="${NETWATCH_ROOT:-/repo}"
WORK=/tmp/netwatch-test
STUBS="$WORK/bin"

setup() {
  rm -rf "$WORK"
  mkdir -p "$STUBS" "$WORK/state"
  # Every dangerous verb becomes a line in a file we can read back.
  for tool in ip modprobe systemctl logger ping; do
    cat >"$STUBS/$tool" <<EOF
#!/bin/bash
echo "$tool \$*" >>"$WORK/calls"
case "$tool" in
  ping) exit \${PING_EXIT:-0} ;;
  ip)
    # 'ip route show default' is how the script finds the gateway and the link.
    if [ "\$1" = "route" ]; then
      [ "\${NO_ROUTE:-0}" = "1" ] || echo "default via 10.0.0.1 dev wlan0 proto dhcp metric 600"
    fi
    if [ "\$1" = "-br" ]; then echo "wlan0  UP  10.0.0.140/24"; fi
    exit 0 ;;
  *) exit 0 ;;
esac
EOF
    chmod +x "$STUBS/$tool"
  done
  # A driver to find, so the reload step has something to name. It has to be a real symlink
  # because the script refuses to follow anything else — see the note there.
  mkdir -p "$WORK/sys/class/net/wlan0/device" "$WORK/modules/brcmfmac"
  SYMLINKS=yes
  ln -sf "$WORK/modules/brcmfmac" "$WORK/sys/class/net/wlan0/device/driver" 2>/dev/null || SYMLINKS=no
  [ -L "$WORK/sys/class/net/wlan0/device/driver" ] || SYMLINKS=no
}

# Some platforms (Git Bash on Windows) cannot make symlinks without special privileges.
# Skipping loudly beats a red suite that says nothing about the code — CI runs this on Linux,
# where the check does apply.
skip_without_symlinks() {
  if [ "${SYMLINKS:-no}" = "yes" ]; then return 1; fi
  echo "  SKIP  $1 (this platform cannot create symlinks)"
  return 0
}

# Run the watchdog once, with the state directory redirected somewhere disposable.
run_once() {
  sed -e "s#^STATE_DIR=.*#STATE_DIR=$WORK/state#" \
      -e "s#/sys/class/net#$WORK/sys/class/net#g" \
      "$ROOT/netwatch.sh" >"$WORK/netwatch.sh"
  chmod +x "$WORK/netwatch.sh"
  # No WORK= in the prefix: the stubs are written with an unquoted heredoc, so the path is
  # already baked into them. Passing it here would only be seen by the forked process, which
  # is precisely the confusion shellcheck flags.
  PATH="$STUBS:$PATH" PING_EXIT="${PING_EXIT:-0}" NO_ROUTE="${NO_ROUTE:-0}" \
    bash "$WORK/netwatch.sh" >/dev/null 2>&1
}

calls() { cat "$WORK/calls" 2>/dev/null || true; }
events() { cat "$WORK/state/recovery.jsonl" 2>/dev/null || true; }
# Absent means zero, exactly as read_count() in the script treats it. A machine that has
# never had a failure never writes the file at all — see the write-reduction case below.
count() { cat "$WORK/state/netwatch.state" 2>/dev/null || echo 0; }

echo "== a reachable gateway does nothing at all =="
setup
PING_EXIT=0 run_once
check "counter stays at zero" "$(count)" "0"
check "no recovery events written" "$(events | wc -l | tr -d ' ')" "0"
if ! calls | grep -qE 'ip link|modprobe|systemctl reboot'; then
  ok "nothing was touched"
else
  bad "took action while the network was fine: $(calls)"
fi

echo "== failures below the threshold only count =="
setup
for _ in 1 2; do PING_EXIT=1 run_once; done
check "counted two failures" "$(count)" "2"
if ! calls | grep -q 'ip link'; then ok "no bounce yet"; else bad "bounced too early"; fi

echo "== the third failure bounces the link =="
setup
for _ in 1 2 3; do PING_EXIT=1 run_once; done
contains "brought the link down" "$(calls)" "ip link set wlan0 down"
contains "brought the link back up" "$(calls)" "ip link set wlan0 up"
contains "recorded the bounce" "$(events)" "link-bounce"
if ! calls | grep -q 'modprobe'; then ok "did not skip ahead to the driver"; else bad "reloaded the driver at step one"; fi

echo "== sustained failure escalates to the driver, once =="
setup
for _ in $(seq 1 6); do PING_EXIT=1 run_once; done
if skip_without_symlinks "driver is resolved by name"; then :; else
  contains "unloaded the driver" "$(calls)" "modprobe -r brcmfmac"
  contains "loaded it again" "$(calls)" "modprobe brcmfmac"
  contains "named the driver in the log" "$(events)" "brcmfmac"
fi
# Whichever branch was taken, the reload step must fire once and only once.
check "escalated to the driver step exactly once" "$(events | grep -c driver-reload)" "1"
if ! calls | grep -q 'systemctl reboot'; then ok "has not rebooted yet"; else bad "rebooted far too early"; fi

echo "== a missing driver link is not treated as a module name =="
# The bug this pins: readlink -f on a path that is not a link returns the path, so the
# basename came out as the literal "driver" and the script ran `modprobe -r driver`. A USB
# adapter that has fallen off the bus is exactly when that happens, and exactly when the
# watchdog is most needed.
setup
rm -rf "$WORK/sys/class/net/wlan0/device/driver"
for _ in $(seq 1 6); do PING_EXIT=1 run_once; done
if ! calls | grep -qE 'modprobe (-r )?driver$'; then
  ok "did not try to unload a module called 'driver'"
else
  bad "ran modprobe on the literal path name: $(calls | grep modprobe)"
fi
contains "said it could not find one" "$(events)" "no driver found"

echo "== and finally reboots =="
setup
for _ in $(seq 1 12); do PING_EXIT=1 run_once; done
contains "rebooted the machine" "$(calls)" "systemctl reboot"
contains "said why" "$(events)" "reboot"

echo "== a reboot does not re-arm itself =="
# The one that turns an outage into a loop. The counter has to be cleared BEFORE the
# reboot, or the machine comes up, finds the network still settling, and goes down again.
check "counter cleared before rebooting" "$(count)" "0"

echo "== recovery is noticed and recorded =="
setup
for _ in 1 2 3; do PING_EXIT=1 run_once; done
PING_EXIT=0 run_once
check "counter reset" "$(count)" "0"
contains "recorded the recovery" "$(events)" "recovered"

echo "== a blip that never reached the threshold is not announced =="
setup
PING_EXIT=1 run_once
PING_EXIT=0 run_once
check "counter reset" "$(count)" "0"
if ! events | grep -q recovered; then
  ok "stayed quiet about one failed ping"
else
  bad "announced a recovery from a single blip"
fi

echo "== no default route counts as unreachable =="
setup
for _ in 1 2 3; do PING_EXIT=0 NO_ROUTE=1 run_once; done
check "counted the missing route as failure" "$(count)" "3"
contains "still tried to repair it" "$(events)" "link-bounce"

echo "== a healthy network does not rewrite the counter every minute =="
# It runs every minute forever on a machine that boots from flash. Writing the same zero
# 1440 times a day to record that nothing happened is the one ongoing cost this has.
setup
PING_EXIT=0 run_once
before="$(stat -c %Y "$WORK/state/netwatch.state" 2>/dev/null || echo none)"
if [ "$before" = "none" ]; then
  ok "wrote nothing at all while healthy"
else
  # A file exists from an earlier failure; it must not be touched again.
  sleep 1
  PING_EXIT=0 run_once
  check "counter file untouched" "$(stat -c %Y "$WORK/state/netwatch.state" 2>/dev/null)" "$before"
fi

echo "== but a changing counter is still recorded =="
setup
PING_EXIT=1 run_once
check "first failure written" "$(count)" "1"
PING_EXIT=1 run_once
check "second failure written" "$(count)" "2"
PING_EXIT=0 run_once
check "reset written" "$(count)" "0"

echo
echo "netwatch: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
