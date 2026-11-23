#!/usr/bin/env bash
# Validate the shared Volta installation before writing systemd units.
verify_shared_volta_runtime() {
  local volta_home="${1:-/opt/global-tools/volta}"
  local service_user="${2:-bridge}"
  local node_binary
  [[ -d "$volta_home" ]] || { echo "Shared Volta runtime missing: $volta_home" >&2; return 1; }
  for executable in volta node; do
    [[ -x "$volta_home/bin/$executable" ]] || {
      echo "Shared Volta runtime is incomplete: $volta_home/bin/$executable is missing or not executable" >&2
      return 1
    }
  done
  if (( EUID == 0 )); then
    command -v runuser >/dev/null 2>&1 || { echo "Cannot verify service-account access: runuser is unavailable" >&2; return 1; }
    getent passwd "$service_user" >/dev/null 2>&1 || { echo "Service account does not exist: $service_user" >&2; return 1; }
  elif [[ "$(id -un)" != "$service_user" ]]; then
    echo "Run the preflight as root or the service account ($service_user)" >&2
    return 1
  fi
  for node_binary in "$volta_home"/tools/image/node/*/bin/node; do
    [[ -x "$node_binary" ]] || continue
    if (( EUID == 0 )); then
      if runuser -u "$service_user" -- "$node_binary" --version >/dev/null 2>&1; then return 0; fi
    elif "$node_binary" --version >/dev/null 2>&1; then
      return 0
    fi
  done
  echo "Shared Volta runtime has no Node executable that $service_user can run" >&2
  return 1
}
