#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=git-issue-common.sh
source "$SCRIPT_DIR/git-issue-common.sh"

ISSUE_ID="${1:-}"
SLUG="${2:-}"
if [[ -z "$ISSUE_ID" || -z "$SLUG" ]]; then
  echo "Usage: $0 REV-77 data-library-change-request-workflow"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo 'ERROR: Working tree is not clean. Commit or stash changes first.'
  exit 1
fi

BASE_BRANCH="$(issue_base_branch)"
BRANCH="$(issue_branch_name "$ISSUE_ID" "$SLUG")"

git fetch origin "$BASE_BRANCH"
if git show-ref --verify --quiet "refs/heads/$BRANCH" || git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "ERROR: Issue branch already exists: $BRANCH. Reuse it for revisions."
  exit 1
fi

git switch -c "$BRANCH" "origin/$BASE_BRANCH"
echo
echo "READY: $BRANCH"
echo "Implement and commit only the $ISSUE_ID work. PR base=$BASE_BRANCH."
