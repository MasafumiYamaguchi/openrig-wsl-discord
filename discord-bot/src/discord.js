import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { safeText, nonceFor } from './bridge.js';

export const allowedMentions = { parse: [], users: [], roles: [], repliedUser: false };

export function commandDefinition() {
  const command = new SlashCommandBuilder().setName('rig').setDescription('OpenRigの統括役に依頼・進捗確認');
  command.addSubcommand(sub => sub.setName('request').setDescription('統括役へ依頼し、専用スレッドで追跡')
    .addStringOption(option => option.setName('text').setDescription('依頼内容').setRequired(true).setMaxLength(4000)));
  for (const name of ['status', 'result']) {
    command.addSubcommand(sub => sub.setName(name).setDescription(name === 'status' ? '依頼の進捗を確認' : '依頼の結果を確認')
      .addStringOption(option => option.setName('task').setDescription('作業ID（依頼スレッドでは省略可）').setMaxLength(100)));
  }
  command.addSubcommand(sub => sub.setName('reply').setDescription('依頼に追加回答・補足を送る')
    .addStringOption(option => option.setName('text').setDescription('回答・補足').setRequired(true).setMaxLength(4000))
    .addStringOption(option => option.setName('task').setDescription('作業ID（依頼スレッドでは省略可）').setMaxLength(100)));
  return command.setDMPermission(false).toJSON();
}

export function chunks(text, maximum = 1800) {
  const result = [];
  let remaining = safeText(text);
  while (remaining.length > maximum) {
    let boundary = remaining.lastIndexOf('\n', maximum);
    if (boundary < maximum / 2) boundary = maximum;
    // Never split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(remaining[boundary - 1])) boundary--;
    result.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\n/, '');
  }
  if (remaining) result.push(remaining);
  return result.length ? result : ['（記録なし）'];
}

export class DiscordTransport {
  constructor(client, config) { Object.assign(this, { client, config }); }

  async channel() {
    const channel = await this.client.channels.fetch(this.config.channelId);
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== this.config.guildId) {
      throw new Error('設定先は指定サーバーの通常のテキストチャンネルにしてください。');
    }
    return channel;
  }

  async ensureThread(job, persist) {
    const channel = await this.channel();
    const message = job.anchorId
      ? await channel.messages.fetch(job.anchorId)
      : await channel.send({ content: `OpenRigへの依頼\n${safeText(job.text).slice(0, 1100)}\n作業ID：${job.id}`,
        nonce: job.interactionId, enforceNonce: true, allowedMentions });
    if (!job.anchorId) { job.anchorId = message.id; persist(); }
    const thread = message.hasThread ? await message.fetchThread() : await message.startThread({
      name: `依頼 ${job.text.replace(/[\r\n]/g, ' ').slice(0, 70)}`,
      autoArchiveDuration: 1440,
      reason: 'OpenRig task tracking',
    });
    if (!thread) throw new Error('依頼スレッドを作成・復元できませんでした。');
    job.threadId = thread.id;
    persist();
  }

  async notify(job, event) {
    const thread = await this.client.channels.fetch(job.threadId);
    if (!thread?.isThread() || thread.parentId !== this.config.channelId || thread.guildId !== this.config.guildId) {
      throw new Error('通知先スレッドが設定チャンネルと一致しません。');
    }
    if (thread.archived) await thread.setArchived(false, 'OpenRig task update');
    const pieces = chunks(event.text);
    for (let index = 0; index < pieces.length; index++) {
      // Discord deduplicates recent retries with the same nonce.
      const nonce = (BigInt(event.nonce) + BigInt(index)).toString();
      await thread.send({ content: pieces[index], nonce, enforceNonce: true, allowedMentions });
    }
  }

  async notifyConversation(event) {
    const channel = await this.channel();
    const pieces = chunks(event.text);
    for (let index = 0; index < pieces.length; index++) {
      await channel.send({ content: pieces[index], nonce: (BigInt(event.nonce) + BigInt(index)).toString(),
        enforceNonce: true, allowedMentions });
    }
  }

  async ensureDecision(entry, card, persist) {
    const channel = await this.channel();
    if (entry.messageId) return;
    if (entry.includeBrief) {
      const full = [`統括役からの確認｜${safeText(entry.summary ?? '')}`, safeText(entry.body ?? ''),
        entry.evidenceRef ? `確認資料：${safeText(entry.evidenceRef)}` : ''].filter(Boolean).join('\n\n');
      const text = full.length <= 24000 ? full : `${full.slice(0, 23500)}\n（長文のため省略。判断に必要な内容が足りない場合は、PC側の質問・資料を確認してください。）`;
      const pieces = chunks(text);
      entry.briefIds ??= [];
      for (let index = entry.briefIds.length; index < pieces.length; index++) {
        const message = await channel.send({ content: pieces[index], nonce: nonceFor(`decision-brief:${entry.key}:${index}`),
          enforceNonce: true, allowedMentions });
        entry.briefIds.push(message.id); persist();
      }
    }
    const recipients = entry.phase === 'open' ? this.config.allowedUserIds : [];
    const mention = recipients.map(id => `<@${id}>`).join(' ');
    const message = await channel.send({ ...card,
      content: mention ? `${mention} 回答をお願いします。\n\n${card.content}` : card.content,
      nonce: nonceFor(`decision-card:${entry.key}`), enforceNonce: true,
      allowedMentions: { ...allowedMentions, users: recipients } });
    entry.messageId = message.id;
    entry.rendered = JSON.stringify(card);
    persist();
  }

  async editDecision(entry, card) {
    const channel = await this.channel();
    const message = await channel.messages.fetch(entry.messageId);
    if (message.author.id !== this.client.user.id) throw new Error('質問カードの投稿者がBotと一致しません。');
    await message.edit({ ...card, allowedMentions });
  }
}

export function interactionContext(interaction) {
  return { guildId: interaction.guildId, channelId: interaction.channelId,
    parentId: interaction.channel?.parentId ?? null, userId: interaction.user.id,
    interactionId: interaction.id };
}

export async function handleInteraction(interaction, bridge, log = console.error) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'rig') return;
  const context = interactionContext(interaction);
  if (!bridge.authorize(context)) {
    await interaction.reply({ content: 'このBotは指定ユーザー・サーバー・チャンネル専用です。', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const subcommand = interaction.options.getSubcommand();
    const id = interaction.options.getString('task');
    let text;
    if (subcommand === 'request') {
      const job = await bridge.submit(context, interaction.options.getString('text', true));
      text = `統括役への依頼を受け付けました。\n作業ID：${job.id}\nhttps://discord.com/channels/${job.guildId}/${job.threadId}`;
    } else if (subcommand === 'reply') {
      const replyId = await bridge.reply(context, interaction.options.getString('text', true), id);
      text = `統括役へ追加回答を送りました。\n回答ID：${replyId}`;
    } else if (subcommand === 'status' || subcommand === 'result') {
      text = await bridge.status(context, id);
    } else throw new Error('未対応のコマンドです。');
    const pieces = chunks(text);
    await interaction.editReply({ content: pieces[0], allowedMentions });
    for (const content of pieces.slice(1)) await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions });
  } catch (error) {
    log(`Discord command failed: ${safeText(error.message).slice(0, 400)}`);
    await interaction.editReply({ content: `処理を完了できませんでした。\n${safeText(error.message).slice(0, 1100)}\n依頼作成が途中の場合、Botが同じ作業IDで受付を再確認します。`, allowedMentions });
  }
}
