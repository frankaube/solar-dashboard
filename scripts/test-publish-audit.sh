#!/usr/bin/env bash
#
# Prove the publish audit cannot silently not-run.
#
#   scripts/test-publish-audit.sh
#
# `publish.sh` decides what reaches a public repository. Its deny-list scan used to be
# `git grep … 2>/dev/null || true`, which hides a failure three ways at once: stderr
# discarded, a non-zero exit swallowed, and empty output indistinguishable from no matches.
# git grep exits 1 when it finds nothing and above 1 when something goes wrong, and that
# form could not tell those apart.
#
# It is not hypothetical. Git Bash's grep aborted on every term twice while auditing a real
# tree, and both times the check reported clean — the second time despite a hand-written
# error guard, which missed it because the abort message goes to the shell rather than to
# grep's stderr. A clean report from a check that never ran is worse than no check, because
# it is the one that gets believed.
#
# So this forces exactly that failure and asserts the publish is refused.
#
# Everything runs in a throwaway clone. `publish.sh` refuses on a dirty tree — correctly,
# since a public commit must name a real source — which would otherwise make this suite
# untestable from a working directory, i.e. from the only place anyone would run it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

pass=0
fail=0

check() {
  # $1 = what is being asserted, $2 = 0 for pass
  if [ "$2" = "0" ]; then
    echo "  ok   $1"
    pass=$((pass + 1))
  else
    echo "  FAIL $1" >&2
    fail=$((fail + 1))
  fi
}

# Assertions run their grep inside `if`, the only context errexit ignores. A bare failing
# grep would abort this script before its own result could be recorded — stopping at the
# first negative rather than reporting it, which is the same class of bug being tested.
expect_in() {
  if printf '%s' "$2" | grep -q -- "$3"; then check "$1" 0; else check "$1" 1; fi
}
expect_not_in() {
  if printf '%s' "$2" | grep -q -- "$3"; then check "$1" 1; else check "$1" 0; fi
}

echo "==> preparing a clean clone"
git clone --quiet --no-hardlinks "$ROOT" "$WORK/repo"
# The deny list is deliberately not in the repository — a file naming what must not be
# published is the worst possible thing to publish — so it is carried across by hand.
if [ -f "$ROOT/.publish-deny" ]; then
  cp "$ROOT/.publish-deny" "$WORK/repo/.publish-deny"
fi
cd "$WORK/repo" || exit 1

# The sabotaged copy lives inside the clone, because publish.sh derives the repository root
# from its own location. An untracked file there would make the tree dirty and publish.sh
# would refuse before reaching the audit — which is what this suite is trying to reach. The
# clone is disposable, so excluding it locally costs nothing.
echo "scripts/publish-broken.sh" >>.git/info/exclude

echo ""
echo "==> a working audit passes"
set +e
good="$(bash scripts/publish.sh --message "audit-test" 2>&1)"
good_status=$?
set -e
if [ "$good_status" -eq 0 ]; then check "it exits zero" 0; else check "it exits zero" 1; fi
expect_in "it builds the public commit" "$good" "one commit, no history"
expect_not_in "it reports no failed search" "$good" "DID NOT RUN"

echo ""
echo "==> the audit refuses when its search cannot run"

# 134 is SIGABRT — what "Aborted (core dumped)" reports, which is exactly how this failed.
sed 's|scan_out="$(git grep $scan_flags -n -I -- "$scan_pattern" "$TREE" 2>"$scan_err")"|scan_out="$(sh -c '"'"'echo "grep: fatal" >\&2; exit 134'"'"' 2>"$scan_err")"|' \
  scripts/publish.sh >scripts/publish-broken.sh

if ! grep -q 'exit 134' scripts/publish-broken.sh; then
  echo "the sabotage did not apply — the scan line in publish.sh has moved." >&2
  echo "This suite would be asserting nothing, so it fails rather than passing quietly." >&2
  exit 1
fi
check "the fault was actually injected" 0

set +e
out="$(bash scripts/publish-broken.sh --message "audit-test" 2>&1)"
status=$?
set -e
expect_in "it says the search did not run" "$out" "DID NOT RUN"
expect_in "it refuses to publish" "$out" "Nothing was published"
if [ "$status" -ne 0 ]; then check "it exits non-zero" 0; else check "it exits non-zero" 1; fi

echo ""
if [ "$fail" -gt 0 ]; then
  echo "$fail failed, $pass passed" >&2
  exit 1
fi
echo "$pass passed"
