#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/openrig/node/bin:$HOME/.local/bin:$PATH"
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$script_directory/../discord-bot"
exec node src/main.js "${@:-start}"
