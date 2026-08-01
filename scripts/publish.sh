#!/usr/bin/env bash
#
# Build the public commit. Does not push.
#
#   scripts/publish.sh
#   scripts/publish.sh --message "0.2.0"
#
# The public repository gets ONE commit with no history, rebuilt from scratch every time.
# That is not tidiness — it is the only way to keep something out of a public repository
# for good. A file deleted in a later commit is still in the history, still on GitHub, and
# still in every clone; the only version of "not published" that holds is never having been
# in the tree that was pushed.
#
# So: docs/ stays private, and this is what enforces it.
#
# The working tree and your real index are never touched. This assembles a tree in a
# temporary index, commits it with plumbing, and points a branch at the result — you stay
# on whatever branch you were on, with whatever you had staged still staged.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SOURCE_BRANCH="$(git symbolic-ref --short HEAD)"
PUBLIC_BRANCH=public

# Never published. Add to this list rather than to .gitignore when something should stay
# in the private history but out of the public tree — those are different questions.
EXCLUDE=(
  docs          # private: research, roadmaps, competitive notes, draft correspondence
  .claude       # local editor and tooling config, of no use to anyone else
)

MESSAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --message) MESSAGE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$(git status --porcelain)" ]; then
  # A dirty tree means the commit would not match anything you can go back to. The public
  # commit has no history of its own, so "which state was that" has only one answer: the
  # private commit it was built from.
  echo "working tree is dirty — commit or stash first, so the public commit names a real source" >&2
  exit 1
fi

SOURCE_SHA="$(git rev-parse --short HEAD)"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
[ -n "$MESSAGE" ] || MESSAGE="Solar Dashboard $VERSION"

# ---------------------------------------------------------------- assemble the tree

TEMP_INDEX="$(mktemp)"
rm -f "$TEMP_INDEX"
cleanup() { rm -f "$TEMP_INDEX"; return 0; }
trap cleanup EXIT INT TERM

export GIT_INDEX_FILE="$TEMP_INDEX"
git read-tree HEAD
for path in "${EXCLUDE[@]}"; do
  # --ignore-unmatch: an entry that is not in the tree is not an error. This list is a
  # standing policy, and a policy that breaks when something is already absent is one
  # people work around.
  git rm -r --cached --quiet --ignore-unmatch "$path"
done
TREE="$(git write-tree)"
unset GIT_INDEX_FILE

# ---------------------------------------------------------------- refuse to publish secrets

# Checked against the tree that is about to be committed, not the working directory, so
# what is inspected is exactly what would be pushed.
DENY_FILE="$ROOT/.publish-deny"
FOUND=0
report() {
  local name="$1" hits="$2"
  if [ -n "$hits" ]; then
    FOUND=1
    echo ""
    echo "!! $name:" >&2
    echo "$hits" | sed "s|^$TREE:|   |" >&2
  fi
}

scan() {
  # $1 = human name, $2 = grep flags, $3 = pattern
  report "$1" "$(git grep $2 -n -I -- "$3" "$TREE" 2>/dev/null | head -20 || true)"
}

# An email address that is not an obvious placeholder — the check that would have caught a
# real one sitting in a test fixture for months.
#
# The exclusions are the reserved names that exist precisely so documentation can use them
# (RFC 2606: .example, .invalid, .test, and example.com/net/org), plus .local, because an
# ssh target like solar@raspberrypi.local is the same shape as an email and appears all
# over the install instructions. Anything real is left to be caught.
report "email addresses" "$(
  git grep -E -n -I -- '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$TREE" 2>/dev/null \
    | grep -v -E '@[A-Za-z0-9.-]*(example\.(com|net|org)|\.local|\.invalid|\.test|\.example)' \
    | grep -v -E '@(example|localhost)' \
    | head -20 || true
)"

# A private deny list — literal strings, one per line, comments with #. Kept out of the
# repository, because a file listing the things that must not be published is itself the
# worst possible thing to publish.
if [ -f "$DENY_FILE" ]; then
  while IFS= read -r term; do
    case "$term" in ''|\#*) continue ;; esac
    scan "denied string: $term" "-F -i" "$term"
  done <"$DENY_FILE"
fi

if [ "$FOUND" = "1" ]; then
  echo "" >&2
  echo "Nothing was published. Fix the above, or add a placeholder to .publish-deny if a" >&2
  echo "match is a false positive (example.com addresses are fine and expected)." >&2
  exit 1
fi

# ---------------------------------------------------------------- commit it

COMMIT="$(git commit-tree "$TREE" -m "$MESSAGE

Built from $SOURCE_BRANCH $SOURCE_SHA.")"
git branch -f "$PUBLIC_BRANCH" "$COMMIT"

FILES="$(git ls-tree -r --name-only "$TREE" | wc -l | tr -d ' ')"
echo "$PUBLIC_BRANCH -> $(git rev-parse --short "$COMMIT")  ($FILES files, one commit, no history)"
echo "  excluded: ${EXCLUDE[*]}"
echo ""
echo "Look at it first:"
echo "  git show --stat $PUBLIC_BRANCH | head -40"
echo "  git ls-tree -r --name-only $PUBLIC_BRANCH | grep -E 'docs/|\\.claude/'   # expect nothing"
echo ""
echo "Then, when you mean it:"
echo "  git push --force origin $PUBLIC_BRANCH:main"
echo ""
echo "--force is expected: every publish is a new commit with no ancestry, so it never"
echo "fast-forwards. Your $SOURCE_BRANCH branch is untouched and stays private."
