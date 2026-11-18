#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
case "$(uname -s)" in
  Darwin) exec /usr/bin/env bash "${ROOT}/scripts/macos/bridge.sh" "$@" ;;
  Linux)  exec /usr/bin/env bash "${ROOT}/scripts/linux/bridge.sh" "$@" ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 2 ;;
esac
