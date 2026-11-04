import { Client, Events, GatewayIntentBits, PermissionFlagsBits, REST, Routes } from 'discord.js';
import { loadConfig, loadToken, stateDirectory, tokenFile } from './config.js';
import { Store } from './store.js';
import { RigClient } from './rig.js';
import { Bridge, safeText } from './bridge.js';
import { commandDefinition, DiscordTransport, handleInteraction, allowedMentions, interactionContext } from './discord.js';
import { ConversationRelay } from './conversation.js';
import { Decisions, handleDecisionInteraction } from './decisions.js';

const config = loadConfig();
const rig = new RigClient();
const mode = process.argv[2] ?? 'start';

async function doctor() {
  console.log(`Discord server: ${config.guildId}`);
  console.log(`Discord channel: ${config.channelId}`);
  console.log(`Allowed users: ${config.allowedUserIds.join(', ')}`);
  console.log(`Destination: ${config.destination}`);
  const seats = await rig.seats(config.rigName);
  const lead = seats.find(seat => seat.canonicalSessionName === config.destination);
  if (!lead) throw new Error('指定統括役が見つかりません。');
  console.log(`Lead: ${lead.runtime}, ${lead.modelObservation?.[0] ?? lead.model ?? 'model unknown'}, ${lead.sessionStatus}`);
  if (lead.sessionStatus !== 'running') throw new Error('統括役が停止しています。チームは自動起動しません。');
  if (lead.needsAttention) console.log('Attention: 統括役に確認待ちがあります。Botはその確認を自動承認しません。');
  try { loadToken(); console.log('Bot token: configured (not displayed)'); }
  catch { console.log(`Bot token: missing; save with scripts/discord-setup-token.sh to ${tokenFile()}`); process.exitCode = 2; }
  console.log('Team/model/config changes: none');
}

async function start() {
  const token = loadToken();
  const store = new Store(stateDirectory());
  store.lock();
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions });
  const log = message => console.error(`${new Date().toISOString()} ${safeText(message)}`);
  const transport = new DiscordTransport(client, config);
  const bridge = new Bridge({ config, store, rig, transport, log });
  const conversation = new ConversationRelay({ config, store, transport, log });
  const decisions = new Decisions({ config, store, rig, transport, log });
  let timer;
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await client.destroy();
    store.unlock();
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('exit', () => store.unlock());
  client.on(Events.Error, error => log(`Discord connection: ${error.message}`));
  client.on(Events.ShardError, error => log(`Discord gateway: ${error.message}`));
  client.on(Events.InteractionCreate, interaction => {
    void (async () => {
      if (await handleDecisionInteraction(interaction, decisions, interactionContext, log)) return;
      await handleInteraction(interaction, bridge, log);
    })().catch(error => log(`Interaction response: ${error.message}`));
  });
  try {
    const ready = new Promise(resolve => client.once(Events.ClientReady, resolve));
    await client.login(token);
    await ready;
    await transport.channel();
    const permissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.SendMessagesInThreads |
      PermissionFlagsBits.ReadMessageHistory;
    const channel = await transport.channel();
    const member = await channel.guild.members.fetchMe();
    if (!channel.permissionsFor(member)?.has(permissions)) throw new Error('Botに表示・送信・公開スレッド作成・スレッド送信・履歴読取の権限が必要です。');
    // Upsert our command only; do not replace other commands on an existing app.
    await client.rest.post(Routes.applicationGuildCommands(client.application.id, config.guildId), { body: commandDefinition() });
    console.log(`Discord Bot ready: ${client.user.tag}; destination=${config.destination}`);
    if (mode === 'register') { await shutdown(); return; }
    await conversation.poll();
    await decisions.poll();
    await bridge.poll();
    timer = setInterval(() => {
      void conversation.poll().catch(error => log(`Conversation monitor: ${error.message}`));
      void decisions.poll().catch(error => log(`Decision monitor: ${error.message}`));
      void bridge.poll().catch(error => log(`Monitor: ${error.message}`));
    }, config.pollSeconds * 1000);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

try {
  if (mode === 'doctor') await doctor();
  else if (mode === 'start' || mode === 'register') await start();
  else if (mode === 'invite') {
    let applicationId = process.argv[3];
    if (!applicationId) {
      const rest = new REST({ version: '10' }).setToken(loadToken());
      applicationId = (await rest.get(Routes.oauth2CurrentApplication())).id;
    }
    if (!/^\d{17,22}$/.test(applicationId ?? '')) throw new Error('DiscordアプリケーションIDが不正です。');
    const permissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.SendMessagesInThreads | PermissionFlagsBits.ReadMessageHistory;
    console.log(`https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${permissions}&guild_id=${config.guildId}&disable_guild_select=true`);
  } else throw new Error('使い方: node src/main.js [start|doctor|register|invite APPLICATION_ID]');
} catch (error) {
  // Never dump SDK request objects, environment variables, or tokens.
  let message = safeText(error.message);
  if (process.env.DISCORD_BOT_TOKEN) message = message.replaceAll(process.env.DISCORD_BOT_TOKEN, '[token removed]');
  console.error(message);
  process.exitCode = 1;
}
