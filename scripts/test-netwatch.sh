#!/usr/bin/env bash
#
# Run the network watchdog's test suite.
#
#   scripts/test-netwatch.sh
#
# Every branch in this script does something that cannot be tried on a machine you are
# logged into: it downs the interface you are connected over, unloads the driver underneath
# it, or reboots. It also only ever runs when nobody is watching, on a box that has already
# stopped answering — so the one chance to find out whether it is right is here.
#
# So `ip`, `modprobe`, `ping`, `systemctl` and `logger` are stubbed inside a throwaway
# container and every call is recorded to a file. What is under test is the decision: how
# many failed checks precede each step, that the steps escalate rather than firing at once,
# that a recovery is noticed, and — the one that matters most — that a reboot clears its own
# counter first, so a machine cannot come up and immediately reboot again.
#
# Needs Docker. It does not need a Pi, a network, or root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required to run the netwatch tests" >&2
  exit 1
}

# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the container-side paths.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOT/packaging/linux:/repo:ro" \
  -v "$ROOT/packaging/linux/test:/test:ro" \
  debian:bookworm-slim bash /test/netwatch-cases.sh
