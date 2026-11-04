#!/usr/bin/env bash
set -euo pipefail
umask 077
token_directory="$HOME/.config/openrig-discord"
mkdir -p "$token_directory"
chmod 700 "$token_directory"
printf 'Discord Developer Portal > application > Bot > Token\n'
printf 'Paste the Bot token below. Input is hidden and is not sent to chat.\n'
IFS= read -r -s -p 'Bot token: ' discord_token </dev/tty
printf '\n'
if [[ ${#discord_token} -lt 30 || "$discord_token" =~ [[:space:]] ]]; then
  printf 'Invalid token format. Nothing was saved.\n' >&2
  exit 1
fi
printf 'DISCORD_BOT_TOKEN=%s\n' "$discord_token" > "$token_directory/bot.env"
chmod 600 "$token_directory/bot.env"
unset discord_token
printf 'Saved to %s/bot.env (permissions 600).\n' "$token_directory"
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
printf '\nInvite URL (open this link and install the bot to your server):\n'
bash "$script_directory/discord-bot.sh" invite || printf 'Token validation failed. Check the Bot token and try again.\n'
printf 'Press Enter to close.\n'
read -r </dev/tty
