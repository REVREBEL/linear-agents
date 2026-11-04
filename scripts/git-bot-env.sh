#!/usr/bin/env bash
# Formats and exports GitHub App Bot Git author/committer identity

APP_NAME="${ANTIGRAVITY_GITHUB_APP_NAME:-${GITHUB_APP_NAME:-rebel-antigravity}}"
APP_ID="${ANTIGRAVITY_GITHUB_APP_ID:-${GITHUB_APP_ID:-5411353}}"

export GIT_AUTHOR_NAME="${APP_NAME}[bot]"
export GIT_AUTHOR_EMAIL="${APP_ID}+${APP_NAME}[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="${APP_NAME}[bot]"
export GIT_COMMITTER_EMAIL="${APP_ID}+${APP_NAME}[bot]@users.noreply.github.com"
