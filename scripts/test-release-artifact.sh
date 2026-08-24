#!/usr/bin/env bash
#
# Install a real release artifact with the real updater, before anyone else does.
#
#   node packaging/build.mjs arm64
#   node packaging/release.mjs arm64
#   scripts/test-release-artifact.sh
#
# scripts/test-updater.sh proves the updater's logic against a fabricated bundle. This
# proves the two halves fit: that what packaging/release.mjs produces is something
# packaging/linux/update.sh can verify, unpack and install — with the real signature over
# the real checksums of the real tarball.
#
# The failures it is looking for are the ones a synthetic fixture cannot have: an archive
# rooted at the wrong directory, a missing Prisma engine, a binary that arrives without its
# executable bit, the test suite accidentally shipping inside the product, a stamp that
# does not match what the bundle actually contains.
#
# The binary itself is never executed — it may well be for another architecture, and the
# health check is stubbed. What is under test is everything around it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/packaging/out"

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

if ! ls "$OUT"/solar-dashboard-*.tar.gz >/dev/null 2>&1; then
  echo "no packaged artifact in $OUT" >&2
  echo "run: node packaging/build.mjs arm64 && node packaging/release.mjs arm64" >&2
  exit 1
fi

MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOT/packaging/linux:/repo:ro" \
  -v "$OUT:/out:ro" \
  -v "$ROOT/packaging/linux/test:/test:ro" \
  debian:bookworm-slim bash /test/real-artifact-cases.sh
