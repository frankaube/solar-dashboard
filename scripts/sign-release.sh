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

# ---------------------------------------------------------------- find the tools
#
# Look on PATH first, then in the places Windows installers actually put things.
#
# Git Bash builds its own PATH and does not always inherit one that a winget install has
# just amended — so `gh` can be installed, working in PowerShell, and invisible here. The
# script then reports "gh is not installed", which is both false and the opposite of
# useful. Searching the obvious locations costs nothing and removes a step that otherwise
# has to be discovered.

resolve() {
  tool_name="$1"
  shift
  if command -v "$tool_name" >/dev/null 2>&1; then
    command -v "$tool_name"
    return 0
  fi
  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

GH="$(resolve gh \
  "/c/Program Files/GitHub CLI/gh.exe" \
  "/c/Program Files (x86)/GitHub CLI/gh.exe" \
  "${PROGRAMFILES:-}/GitHub CLI/gh.exe")" || {
  echo "gh was not found on PATH or in the usual install locations." >&2
  echo "  install it:  winget install --id GitHub.cli" >&2
  echo "  or open a new shell, if you installed it since this one started" >&2
  exit 1
}

MINISIGN="$(resolve minisign \
  /c/Users/*/AppData/Local/Microsoft/WinGet/Packages/jedisct1.minisign*/minisign-win64/x86_64/minisign.exe \
  "/c/Program Files/minisign/minisign.exe")" || {
  echo "minisign was not found on PATH or in the usual install locations." >&2
  echo "  install it:  winget install --id jedisct1.minisign" >&2
  exit 1
}

echo "==> gh:       $GH"
echo "==> minisign: $MINISIGN"

REPO="$("$GH" repo view --json nameWithOwner --jq .nameWithOwner)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

# ---------------------------------------------------------------- sign

echo "==> downloading SHA256SUMS for $TAG"
"$GH" release download "$TAG" -p SHA256SUMS -R "$REPO" --dir "$WORK" --clobber

echo "==> signing (minisign will ask for your password; this script never sees it)"
"$MINISIGN" -Sm "$WORK/SHA256SUMS"

# Verify our own output before it goes anywhere. A signature made with the wrong key is
# indistinguishable from a good one until a Pi refuses it hours later, at which point the
# release looks broken rather than mis-signed.
if [ -n "$PUBKEY" ]; then
  echo "==> verifying against the supplied public key"
  "$MINISIGN" -V -P "$PUBKEY" -m "$WORK/SHA256SUMS" -x "$WORK/SHA256SUMS.minisig" >/dev/null
  echo "    signature verifies"
else
  echo "    (no --pubkey given; skipping the verify that would catch signing with the wrong key)"
fi

echo "==> uploading SHA256SUMS.minisig"
"$GH" release upload "$TAG" "$WORK/SHA256SUMS.minisig" -R "$REPO" --clobber

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
  "$GH" release edit "$TAG" --notes-file "$NOTES" -R "$REPO"
fi

# ---------------------------------------------------------------- publish

echo "==> publishing"
"$GH" release edit "$TAG" --draft=false -R "$REPO"

echo ""
echo "$TAG is signed and published. Installations will accept it from now on."
