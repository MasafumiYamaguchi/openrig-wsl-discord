#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/openrig/node/bin:$HOME/.local/bin:$PATH"
backup="$HOME/.local/share/openrig/backups/$(date +%Y%m%d-%H%M%S)-setup"
mkdir -p "$backup"
chmod 700 "$backup"
for relative in .tmux.conf .codex/config.toml .claude.json .claude/settings.json; do
  if [ -f "$HOME/$relative" ]; then
    mkdir -p "$backup/$(dirname "$relative")"
    cp -p "$HOME/$relative" "$backup/$relative"
  fi
done
printf 'Configuration backup directory: %s\n' "$backup"
rig setup --providers both --no-herdr
rig doctor
