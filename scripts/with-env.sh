#!/usr/bin/env bash
# Central environment entrypoint for Terraform and the four Linear Workers.

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
  echo "       scripts/with-env.sh worker <antigravity|trae|chatgpt|gemini> <dev|deploy|sync-secrets|types>" >&2
  echo "       scripts/with-env.sh bridge <node args...>" >&2
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
      *) usage ;;
    esac
    cd "${worker_dir}"
    wrangler_bin="${REPO_ROOT}/node_modules/.bin/wrangler"
    if [[ ! -x "${wrangler_bin}" ]]; then
      echo "Wrangler is not installed. Run npm ci from ${REPO_ROOT} first." >&2
      exit 1
    fi
    wrangler_cmd=("${wrangler_bin}")
    case "${action}" in
      types) exec "${wrangler_cmd[@]}" types "$@" ;;
      sync-secrets)
        require BRIDGE_SHARED_SECRET
        for key in LINEAR_CLIENT_ID LINEAR_CLIENT_SECRET LINEAR_WEBHOOK_SECRET; do
          sourced_key="${prefix}_${key}"
          require "${sourced_key}"
          printf '%s' "${!sourced_key}" | "${wrangler_cmd[@]}" secret put "${key}" "$@"
        done
        printf '%s' "${BRIDGE_SHARED_SECRET}" | "${wrangler_cmd[@]}" secret put BRIDGE_SHARED_SECRET "$@"
        echo "Synced four secrets to ${agent}. Verify the active Cloudflare account/Worker."
        ;;
      deploy)
      
        # Wrangler deploy does not import secrets from the root .env. Run sync-secrets after deploy.
        exec "${wrangler_cmd[@]}" deploy "$@"
        ;;
      dev)
        # Wrangler dev reads .dev.vars in this worker directory.
        # Only create it temporarily, without overwriting a user-owned file.
        if [[ -e .dev.vars ]]; then
          echo "Refusing to overwrite pre-existing ${worker_dir}/.dev.vars" >&2
          exit 1
        fi
        require BRIDGE_SHARED_SECRET
        umask 077
        : > .dev.vars
        cleanup() { rm -f -- .dev.vars; }
        trap cleanup EXIT INT TERM
        for key in LINEAR_CLIENT_ID LINEAR_CLIENT_SECRET LINEAR_WEBHOOK_SECRET; do
          sourced_key="${prefix}_${key}"
          require "${sourced_key}"
          # JSON string values are valid dotenv double-quoted values.
          KEY="${key}" VALUE="${!sourced_key}" python3 -c 'import json,os; print(os.environ["KEY"]+"="+json.dumps(os.environ["VALUE"]))' >> .dev.vars
        done
        KEY=BRIDGE_SHARED_SECRET VALUE="${BRIDGE_SHARED_SECRET}" python3 -c 'import json,os; print(os.environ["KEY"]+"="+json.dumps(os.environ["VALUE"]))' >> .dev.vars
        "${wrangler_cmd[@]}" dev "$@"
        ;;
      *) usage ;;
    esac
    ;;
  *) usage ;;
esac
