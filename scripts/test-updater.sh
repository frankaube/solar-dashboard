#!/usr/bin/env bash
#
# Run the updater's test suite.
#
#   scripts/test-updater.sh
#
# The updater is a root-owned shell script that downloads a binary from the internet,
# verifies a signature, replaces a running service and rolls back if the result does not
# answer. None of that can be exercised by the unit tests, and all of it runs unattended at
# 3 AM on a machine nobody is watching — which is the definition of code that needs a test
# more than most.
#
# So it runs in a throwaway Debian container: a real minisign keypair is generated inside,
# a release is built and signed, and the failure paths are forced one at a time. systemctl
# and the health endpoint are stubbed, so "the new build came up" and "the new build did
# not come up" are both reproducible rather than hoped for.
#
# Needs Docker. It does not need a Pi, a GitHub repository, or a published release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required to run the updater tests" >&2
  exit 1
}

# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the container-side paths.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOT/packaging/linux:/repo:ro" \
  -v "$ROOT/packaging/linux/test:/test:ro" \
  debian:bookworm-slim bash /test/update-cases.sh
