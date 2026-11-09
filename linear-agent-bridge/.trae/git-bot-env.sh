#!/usr/bin/env bash

# GitHub App bot identity for commits created by Trae.
app_name="${TRAE_GITHUB_APP_NAME:-${GITHUB_APP_NAME:-revrebel-trae}}"
app_id="${TRAE_GITHUB_APP_ID:-${GITHUB_APP_ID:-5660644}}"

export GIT_AUTHOR_NAME="${app_name}[bot]"
export GIT_AUTHOR_EMAIL="${app_id}+${app_name}[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="${app_name}[bot]"
export GIT_COMMITTER_EMAIL="${app_id}+${app_name}[bot]@users.noreply.github.com"
