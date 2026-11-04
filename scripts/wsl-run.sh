#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/openrig/node/bin:$HOME/.local/bin:$PATH"
exec "$@"
