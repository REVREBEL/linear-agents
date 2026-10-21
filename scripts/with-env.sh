#!/usr/bin/env bash
# Central environment entrypoint for Terraform and the five Linear Workers.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

ENV_FILE="${LINEAR_AGENTS_ENV_FILE:-${REPO_ROOT}/.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Copy .env.example to .env and fill it." >&2
  exit 1
fi
set -a

# Source only your own trusted local .env (this is a shell file).
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

usage() {
  echo "Usage: scripts/with-env.sh terraform <terraform args...>" >&2
  echo "       scripts/with-env.sh worker <antigravity|trae|chatgpt|gemini|mock> <dev|deploy|sync-secrets|types>" >&2
  echo "       scripts/with-env.sh bridge <node args...>" >&2
  echo "       scripts/with-env.sh linear-projects" >&2
  exit 2
}
require() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then echo "Missing environment variable: ${key}" >&2; exit 1; fi
}
export TF_VAR_cloudflare_account_id="${CLOUDFLARE_ACCOUNT_ID:-}"
export TF_VAR_cloudflare_zone_id="${CLOUDFLARE_ZONE_ID:-}"
export TF_VAR_cloudflare_domain="${DOMAIN:-}"

case "${1:-}" in
  mock-agent)
    shift
    require LINEAR_API_KEY
    cd "${REPO_ROOT}"
    exec node "${REPO_ROOT}/scripts/mock-agent.mjs" "$@"
    ;;
  linear-projects)
    require LINEAR_API_KEY
    cd "${REPO_ROOT}"
    exec node "${REPO_ROOT}/scripts/linear-projects.mjs"
    ;;
  terraform)
    shift
    cd "${REPO_ROOT}/infrastructure/cloudflare"
    if ! command -v terraform >/dev/null 2>&1; then
      echo "Terraform CLI is not installed or is not on PATH." >&2
      echo "On macOS, install it with: brew tap hashicorp/tap && brew install hashicorp/tap/terraform" >&2
      echo "Then verify with: terraform version" >&2
      exit 127
    fi
    exec terraform "$@"
    ;;
  bridge)
    shift
    require BRIDGE_SHARED_SECRET
    cd "${REPO_ROOT}"
    exec node "${REPO_ROOT}/linear-agent-bridge/agent-bridge.mjs" "$@"
    ;;
  worker)
    shift
    agent="${1:-}"; action="${2:-}"; shift 2 || usage
    case "${agent}" in
      antigravity) worker_dir="${REPO_ROOT}/linear-antigravity-worker"; prefix="ANTIGRAVITY" ;;
      trae) worker_dir="${REPO_ROOT}/linear-trae-worker"; prefix="TRAE" ;;
      chatgpt) worker_dir="${REPO_ROOT}/linear-chatgpt-worker"; prefix="CHATGPT" ;;
      gemini) worker_dir="${REPO_ROOT}/linear-gemini-worker"; prefix="GEMINI" ;;
      mock) worker_dir="${REPO_ROOT}/linear-mock-worker"; prefix="MOCK" ;;
      *) usage ;;
    esac
    if [[ "${action}" == kv ]]; then
      require CLOUDFLARE_ACCOUNT_ID
      require CLOUDFLARE_API_TOKEN
      cd "${REPO_ROOT}"
      node "${REPO_ROOT}/scripts/setup-kv.mjs" "${agent}"
      exit $?
    fi
    cd "${worker_dir}"
    wrangler_bin="${REPO_ROOT}/node_modules/.bin/wrangler"
    if [[ ! -x "${wrangler_bin}" ]]; then
      echo "Wrangler is not installed. Run npm ci from ${REPO_ROOT} first." >&2
      exit 1
    fi
    # Keep domain, OAuth endpoints and KV IDs in the untracked .env.
    # Generate a short-lived Wrangler config beside its source entrypoint.
    temp_config="${worker_dir}/wrangler.local.$.$RANDOM.jsonc"
    cleanup_config() { rm -f -- "${temp_config}"; }
    trap cleanup_config EXIT
    node "${REPO_ROOT}/scripts/render-wrangler.mjs" "${agent}" "${temp_config}"
    wrangler_cmd=("${wrangler_bin}" --config "${temp_config}")
    case "${action}" in
      types) "${wrangler_bin}" types --config "${temp_config}" "$@" ;;
      sync-secrets)
        require BRIDGE_SHARED_SECRET
        for key in LINEAR_CLIENT_ID LINEAR_CLIENT_SECRET LINEAR_WEBHOOK_SECRET; do
          sourced_key="${prefix}_${key}"
          require "${sourced_key}"
          printf '%s' "${!sourced_key}" | "${wrangler_bin}" secret put "${key}" --config "${temp_config}" "$@"
        done
        printf '%s' "${BRIDGE_SHARED_SECRET}" | "${wrangler_bin}" secret put BRIDGE_SHARED_SECRET --config "${temp_config}" "$@"
        ;;
      deploy) "${wrangler_bin}" deploy --config "${temp_config}" "$@" ;;
      dev)
        if [[ -e .dev.vars ]]; then
          echo "Refusing to overwrite pre-existing ${worker_dir}/.dev.vars" >&2
          exit 1
        fi
        require BRIDGE_SHARED_SECRET
        umask 077
        : > .dev.vars
        cleanup() { rm -f -- .dev.vars; cleanup_config; }
        trap cleanup EXIT INT TERM
        for key in LINEAR_CLIENT_ID LINEAR_CLIENT_SECRET LINEAR_WEBHOOK_SECRET; do
          sourced_key="${prefix}_${key}"
          require "${sourced_key}"
          KEY="${key}" VALUE="${!sourced_key}" python3 -c 'import json,os; print(os.environ["KEY"]+"="+json.dumps(os.environ["VALUE"]))' >> .dev.vars
        done
        KEY=BRIDGE_SHARED_SECRET VALUE="${BRIDGE_SHARED_SECRET}" python3 -c 'import json,os; print(os.environ["KEY"]+"="+json.dumps(os.environ["VALUE"]))' >> .dev.vars
        "${wrangler_bin}" dev --config "${temp_config}" "$@"
        ;;
      *) usage ;;
    esac
    ;;
  *) usage ;;
esac
