#!/usr/bin/env bash
# launchd bridge entrypoint: trusted environment, absolute Node and bridge path.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="${LINEAR_AGENTS_ENV_FILE:-${ROOT}/.env}"
if [[ ! -f "${ENV_FILE}" ]]; then echo "Missing bridge environment: ${ENV_FILE}" >&2; exit 1; fi
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a
if [[ -z "${BRIDGE_SHARED_SECRET:-}" ]]; then echo "BRIDGE_SHARED_SECRET is required" >&2; exit 1; fi
NODE_BIN="${BRIDGE_NODE_BIN:-${1:-}}"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then echo "An executable absolute Node path is required" >&2; exit 1; fi
shift || true
cd "${ROOT}"
exec "${NODE_BIN}" "${ROOT}/linear-agent-bridge/agent-bridge.mjs" "$@"
