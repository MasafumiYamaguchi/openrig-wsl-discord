#!/usr/bin/env bash
set -euo pipefail
umask 077
base="$HOME/.local/share/openrig"
mkdir -p "$base/downloads" "$HOME/.local/bin"
export PATH="$base/node/bin:$HOME/.local/bin:$PATH"
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo 'Unsupported architecture'; exit 1 ;; esac
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit([22,24].includes(+process.versions.node.split(".")[0])?0:1)'; then
  curl --fail --show-error --silent --location https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$base/downloads/SHASUMS256.txt"
  archive=$(awk -v suffix="-linux-$arch.tar.xz" 'index($2,suffix) && $2 ~ /\.tar\.xz$/ {print $2; exit}' "$base/downloads/SHASUMS256.txt")
  test -n "$archive"
  curl --fail --show-error --silent --location "https://nodejs.org/dist/latest-v22.x/$archive" -o "$base/downloads/$archive"
  (cd "$base/downloads"; awk -v file="$archive" '$2 == file' SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$base/node"
  tar -xJf "$base/downloads/$archive" -C "$base/node" --strip-components=1
fi
backup="$base/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
for profile in .profile .bashrc; do
  path="$HOME/$profile"
  if ! grep -q '^# BEGIN OpenRig runtime PATH$' "$path" 2>/dev/null; then
    if [ -f "$path" ]; then cp -p "$path" "$backup/$profile"; fi
    cat >> "$path" <<'PROFILE'

# BEGIN OpenRig runtime PATH
export PATH="$HOME/.local/share/openrig/node/bin:$HOME/.local/bin:$PATH"
# END OpenRig runtime PATH
PROFILE
  fi
done
printf '\nInstalling OpenRig and both providers in ~/.local\n'
npm install --global --prefix "$HOME/.local" @openrig/cli@0.7.5 @openai/codex @anthropic-ai/claude-code
printf '\nInstalled versions:\n'
node --version
rig --version
codex --version
claude --version
printf '\nSetup preview:\n'
rig setup --providers both --no-herdr --dry-run
