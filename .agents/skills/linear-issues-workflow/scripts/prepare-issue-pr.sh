#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=git-issue-common.sh
source "$SCRIPT_DIR/git-issue-common.sh"

ISSUE_ID="${1:-}"
if [[ -z "$ISSUE_ID" ]]; then
  echo "Usage: $0 REV-77"
  exit 1
fi

# Run through Bash so repository checkouts do not require executable file modes.
bash "$SCRIPT_DIR/verify-issue-branch.sh" "$ISSUE_ID"

if [[ -n "$(git status --porcelain)" ]]; then
  echo 'ERROR: Commit all intended changes before publishing.'
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
BASE_BRANCH="$(issue_base_branch)"
git push -u origin "$CURRENT_BRANCH"

echo
echo 'Branch published.'
echo "Create/update the PR using base=$BASE_BRANCH and compare=$CURRENT_BRANCH."
