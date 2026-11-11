#!/usr/bin/env bash
# Shared Git policy discovery for issue scripts.
# ISSUE_BASE_BRANCH overrides the remote default branch when explicitly configured.
issue_base_branch() {
  if [[ -n "${ISSUE_BASE_BRANCH:-}" ]]; then
    printf '%s\n' "$ISSUE_BASE_BRANCH"
    return
  fi
  local head
  head="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -z "$head" ]]; then
    head="$(git ls-remote --symref origin HEAD 2>/dev/null | awk '$1 == "ref:" && $3 == "HEAD" {sub("^refs/heads/", "", $2); print $2; exit}')"
  else
    head="${head#origin/}"
  fi
  if [[ -z "$head" ]]; then
    echo 'ERROR: Could not determine base branch. Set ISSUE_BASE_BRANCH explicitly.' >&2
    return 1
  fi
  printf '%s\n' "$head"
}

issue_branch_name() {
  local issue_id="$1" slug="$2"
  local safe_issue safe_slug prefix
  safe_issue="$(printf '%s' "$issue_id" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//')"
  safe_slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  prefix="${ISSUE_BRANCH_PREFIX:-issue}"
  prefix="${prefix%/}"
  if [[ -z "$safe_issue" || -z "$safe_slug" || -z "$prefix" ]]; then
    echo 'ERROR: Invalid issue ID, slug, or ISSUE_BRANCH_PREFIX.' >&2
    return 1
  fi
  printf '%s/%s-%s\n' "$prefix" "$safe_issue" "$safe_slug"
}
