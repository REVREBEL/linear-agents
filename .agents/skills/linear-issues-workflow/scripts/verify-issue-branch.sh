#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=git-issue-common.sh
source "$SCRIPT_DIR/git-issue-common.sh"

EXPECTED_ISSUE="${1:-}"
CURRENT_BRANCH="$(git branch --show-current)"
BASE_BRANCH="$(issue_base_branch)"
ERRORS=0

echo "Current branch: $CURRENT_BRANCH"
echo "Required PR base: $BASE_BRANCH"
echo

if [[ -z "$CURRENT_BRANCH" ]]; then
  echo 'ERROR: Detached HEAD; switch to an issue branch.'
  ERRORS=$((ERRORS + 1))
fi

if [[ "$CURRENT_BRANCH" == "$BASE_BRANCH" || "$CURRENT_BRANCH" == main || "$CURRENT_BRANCH" == master || "$CURRENT_BRANCH" == dev || "$CURRENT_BRANCH" == develop ]]; then
  echo "ERROR: Do not implement directly on a protected/base branch: $CURRENT_BRANCH."
  ERRORS=$((ERRORS + 1))
fi

if [[ -n "$EXPECTED_ISSUE" ]]; then
  ISSUE_LOWER="$(printf '%s' "$EXPECTED_ISSUE" | tr '[:upper:]' '[:lower:]')"
  BRANCH_LOWER="$(printf '%s' "$CURRENT_BRANCH" | tr '[:upper:]' '[:lower:]')"
  if [[ ! "$BRANCH_LOWER" =~ (^|/|-)${ISSUE_LOWER}(-|$) ]]; then
    echo "ERROR: Branch name does not identify issue $EXPECTED_ISSUE."
    ERRORS=$((ERRORS + 1))
  fi
fi

if ! git fetch origin "$BASE_BRANCH"; then
  echo "ERROR: Cannot fetch origin/$BASE_BRANCH."
  exit 1
fi

if ! git merge-base --is-ancestor "origin/$BASE_BRANCH" HEAD; then
  echo "ERROR: Branch does not contain current origin/$BASE_BRANCH."
  echo "Update your issue branch from $BASE_BRANCH before submitting for review."
  ERRORS=$((ERRORS + 1))
else
  echo "Base check passed: branch contains origin/$BASE_BRANCH."
fi

echo
printf 'Commits not in origin/%s:\n' "$BASE_BRANCH"
git log --oneline "origin/$BASE_BRANCH..HEAD" || true

echo
printf 'Files changed from origin/%s:\n' "$BASE_BRANCH"
git diff --name-only "origin/$BASE_BRANCH...HEAD" || true

echo
if [[ "$ERRORS" -gt 0 ]]; then
  echo "FAILED: $ERRORS issue(s) found."
  exit 1
fi

echo 'PASSED'
echo "Pull request: base=$BASE_BRANCH, compare=$CURRENT_BRANCH"
