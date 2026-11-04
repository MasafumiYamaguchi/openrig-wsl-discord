#!/usr/bin/env bash
set -u
printf 'User: '; whoami
printf 'Home: %s\n' "$HOME"
printf '\nTools before loading nvm:\n'
for tool in rig node npm tmux codex claude curl git; do
  command -v "$tool" || true
done
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
  printf '\nnvm versions:\n'
  nvm ls --no-colors
fi
printf '\nVersions:\n'
for tool in rig node npm tmux codex claude; do
  if command -v "$tool" >/dev/null 2>&1; then
    case "$tool" in
      tmux) tmux -V ;;
      *) "$tool" --version ;;
    esac
  fi
done
printf '\nAuthentication:\n'
if command -v codex >/dev/null 2>&1; then codex login status; fi
if command -v claude >/dev/null 2>&1; then claude auth status; fi
printf '\nExisting configuration files (names only):\n'
for file in "$HOME/.tmux.conf" "$HOME/.codex/config.toml" "$HOME/.codex/auth.json" "$HOME/.claude.json"; do
  if [ -f "$file" ]; then printf '%s\n' "$file"; fi
done
