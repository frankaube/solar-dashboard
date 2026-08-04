#!/usr/bin/env bash
#
# Sign a drafted release, and replace the placeholder notes with real ones.
#
#   scripts/sign-release.sh v0.1.2
#   scripts/sign-release.sh v0.1.2 --pubkey RWQ...    # verify before uploading
#
# Run this on the machine holding the signing key. It never sees the key or the password:
# `minisign -Sm` prompts you directly, and this script only moves the file it produces.
#
# WHY THIS EXISTS
#
# The release workflow writes notes that say "Not installable yet" and lists the four
# commands that finish the job. That is correct at the moment it is written and wrong from
# the moment the job is finished — nothing rewrites it, so a signed, published, perfectly
# installable release goes on announcing that it cannot be installed. The first release to
# hit that got its notes rewritten by hand; the second one nobody noticed.
#
# Worse, running those four commands in order publishes LAST but signs FIRST only if you
# read them as a sequence. Publishing without signing leaves a release that the updater
# refuses and whose notes are, accidentally, still accurate. This does them in an order
# where that cannot happen: sign, verify, upload, rewrite, and only then publish.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG="${1:-}"
PUBKEY=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --pubkey) PUBKEY="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TAG" ]; then
  echo "usage: scripts/sign-release.sh <tag> [--pubkey RWQ...]" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "gh is not installed" >&2; exit 1; }
command -v minisign >/dev/null 2>&1 || { echo "minisign is not installed" >&2; exit 1; }

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

# ---------------------------------------------------------------- sign

echo "==> downloading SHA256SUMS for $TAG"
gh release download "$TAG" -p SHA256SUMS -R "$REPO" --dir "$WORK" --clobber

echo "==> signing (minisign will ask for your password; this script never sees it)"
minisign -Sm "$WORK/SHA256SUMS"

# Verify our own output before it goes anywhere. A signature made with the wrong key is
# indistinguishable from a good one until a Pi refuses it hours later, at which point the
# release looks broken rather than mis-signed.
if [ -n "$PUBKEY" ]; then
  echo "==> verifying against the supplied public key"
  minisign -V -P "$PUBKEY" -m "$WORK/SHA256SUMS" -x "$WORK/SHA256SUMS.minisig" >/dev/null
  echo "    signature verifies"
else
  echo "    (no --pubkey given; skipping the verify that would catch signing with the wrong key)"
fi

echo "==> uploading SHA256SUMS.minisig"
gh release upload "$TAG" "$WORK/SHA256SUMS.minisig" -R "$REPO" --clobber

# ---------------------------------------------------------------- real notes

# The changelog section for this version, verbatim: everything between its heading and the
# next one. Written once, in the file that is already the record, rather than a second time
# into a release body that then disagrees with it.
VERSION="${TAG#v}"
NOTES="$WORK/notes.md"
awk -v version="$VERSION" '
  $0 ~ "^## " version "( |$|—)" { inside = 1; next }
  inside && /^## / { exit }
  inside { print }
' CHANGELOG.md > "$NOTES"

if [ ! -s "$NOTES" ]; then
  echo "no CHANGELOG section found for $VERSION — leaving the notes alone" >&2
else
  {
    echo ""
    echo "---"
    echo ""
    echo "Signed with minisign over \`SHA256SUMS\`. The updater verifies this signature"
    echo "against its configured public key and refuses anything without one."
    echo ""
    echo "## Checksums"
    echo ""
    echo '```'
    cat "$WORK/SHA256SUMS"
    echo '```'
  } >> "$NOTES"

  echo "==> replacing the release notes"
  gh release edit "$TAG" --notes-file "$NOTES" -R "$REPO"
fi

# ---------------------------------------------------------------- publish

echo "==> publishing"
gh release edit "$TAG" --draft=false -R "$REPO"

echo ""
echo "$TAG is signed and published. Installations will accept it from now on."
