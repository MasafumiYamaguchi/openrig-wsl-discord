import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function validateConfig(config) {
  for (const key of ['guildId', 'channelId']) {
    if (!/^\d{17,22}$/.test(config[key] ?? '')) throw new Error(`${key}を設定してください。`);
  }
  if (!Array.isArray(config.allowedUserIds) || !config.allowedUserIds.length ||
      config.allowedUserIds.some(id => !/^\d{17,22}$/.test(id))) {
    throw new Error('allowedUserIdsには利用者のDiscord IDが必要です。');
  }
  if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$/.test(config.destination ?? '') ||
      config.destination.split('@')[1] !== config.rigName) throw new Error('統括役の宛先が不正です。');
  config.pollSeconds ??= 15;
  config.maxActiveTasks ??= 20;
  config.relayConversation ??= false;
  config.decisionButtons ??= false;
  config.decisionRecipient ??= 'human@kernel';
  if (typeof config.decisionButtons !== 'boolean' || !/^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/.test(config.decisionRecipient)) {
    throw new Error('質問ボタン設定または本人の宛先が不正です。');
  }
  if (typeof config.relayConversation !== 'boolean') throw new Error('relayConversationはtrueまたはfalseにしてください。');
  if (!Number.isInteger(config.pollSeconds) || config.pollSeconds < 5 || config.pollSeconds > 300) {
    throw new Error('pollSecondsは5〜300秒にしてください。');
  }
  if (!Number.isInteger(config.maxActiveTasks) || config.maxActiveTasks < 1 || config.maxActiveTasks > 100) {
    throw new Error('maxActiveTasksは1〜100にしてください。');
  }
  return config;
}

export function loadConfig() {
  const configFile = process.env.BRIDGE_CONFIG ?? path.join(projectRoot, 'config.json');
  return validateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
}

export function tokenFile() {
  return process.env.BRIDGE_TOKEN_FILE ?? path.join(os.homedir(), '.config', 'openrig-discord', 'bot.env');
}

export function loadToken() {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN.trim();
  let content;
  try { content = fs.readFileSync(tokenFile(), 'utf8'); }
  catch { throw new Error('Botトークン未設定です。scripts/discord-setup-token.shで保存してください。'); }
  const token = content.match(/^DISCORD_BOT_TOKEN=([^\r\n]+)$/m)?.[1]?.trim();
  if (!token) throw new Error('トークンファイルにDISCORD_BOT_TOKENがありません。');
  return token;
}

export function stateDirectory() {
  return process.env.BRIDGE_STATE_DIR ?? path.join(os.homedir(), '.local', 'state', 'openrig-discord');
}
