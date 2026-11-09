#!/usr/bin/env bash
set -euo pipefail

git_bin="$(command -v git || true)"
[[ -n "$git_bin" ]] || exit 0
repo_root="$($git_bin rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || exit 0

script_dir="/Users/garystringham/.trae/scripts"
# shellcheck source=/dev/null
source "$script_dir/git-bot-env.sh"

node_bin="$(command -v node || true)"
[[ -n "$node_bin" ]] || exit 0
credential_helper="!f() { \"$node_bin\" \"$script_dir/mint-github-app-token.mjs\" credential \"\$@\"; }; f"

"$git_bin" -C "$repo_root" config --local user.name "$GIT_AUTHOR_NAME"
"$git_bin" -C "$repo_root" config --local user.email "$GIT_AUTHOR_EMAIL"
# An empty helper entry resets inherited helpers before the App helper runs.
"$git_bin" -C "$repo_root" config --local --replace-all credential.helper ""
"$git_bin" -C "$repo_root" config --local --add credential.helper "$credential_helper"
"$git_bin" -C "$repo_root" config --local credential.https://github.com.useHttpPath true
