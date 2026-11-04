import crypto from 'node:crypto';
import { nonceFor, safeText } from './bridge.js';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
const idPattern = /^[A-Za-z0-9_-]{1,40}$/;

export function validQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return false;
  const ids = new Set();
  return value.every(q => {
    if (!idPattern.test(q.id ?? '') || ids.has(q.id) || typeof q.question !== 'string' ||
        !q.question.trim() || q.question.length > 500 || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return false;
    ids.add(q.id);
    const options = new Set();
    return q.options.every(o => {
      if (!idPattern.test(o.id ?? '') || options.has(o.id) || typeof o.label !== 'string' || !o.label.trim() || o.label.length > 75 ||
          (o.recommended !== undefined && typeof o.recommended !== 'boolean')) return false;
      options.add(o.id);
      return true;
    }) && q.options.filter(o => o.recommended).length <= 1;
  });
}

export function decisionVersion(row) {
  return crypto.createHash('sha256').update(JSON.stringify({ id: row.qitemId, source: row.sourceSession,
    recipient: row.destinationSession, questions: row.humanQuestions, body: row.body,
    summary: row.summary, evidence: row.evidenceRef, expiresAt: row.expiresAt })).digest('hex');
}

export function decisionKey(row, question) {
  return crypto.createHash('sha256').update(`${decisionVersion(row)}:${question.id}`).digest('hex').slice(0, 24);
}

export function buttonRows(entry) {
  return [{ type: 1, components: entry.question.options.map((option, index) => ({
    type: 2, style: option.recommended ? 1 : 2,
    label: safeText(`${option.recommended ? '★ ' : ''}${option.label}`).slice(0, 80),
    custom_id: `rigpick:${entry.key}:${index}`, disabled: entry.phase !== 'open',
  })) }];
}

export function decisionCard(entry) {
  const parts = ['本人の選択待ち', safeText(entry.question.question), `質問ID：${entry.qitemId} / ${entry.question.id}`];
  if (entry.phase === 'answer-pending') parts.push('回答を保存しました。OpenRigへの反映を確認中です。');
  if (entry.phase === 'answered') parts.push(`回答済み：${safeText(entry.answerLabel ?? '')}`);
  if (entry.phase === 'closed') parts.push('受付終了：PC側で回答済み、期限切れ、または質問が更新されました。');
  return { content: parts.join('\n\n'), components: buttonRows(entry) };
}

export class Decisions {
  constructor({ config, store, rig, transport, log = console.error, now = () => Date.now() }) {
    Object.assign(this, { config, store, rig, transport, log, now });
    this.locks = new Map();
    this.polling = false;
    this.entries = this.store.data.decisions ??= {};
  }

  authorized(context) {
    return context.guildId === this.config.guildId && context.channelId === this.config.channelId &&
      this.config.allowedUserIds.includes(context.userId);
  }

  eligible(row) {
    return /^qitem-[A-Za-z0-9_-]+$/.test(row.qitemId ?? '') && row.sourceSession === this.config.destination &&
      row.destinationSession === this.config.decisionRecipient && row.humanIntent !== 'update' && validQuestions(row.humanQuestions);
  }

  expired(row) { return !!row.expiresAt && (!Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= this.now()); }

  async locked(id, operation) {
    if (this.locks.has(id)) throw new Error('同じ依頼の回答を処理中です。少し待って確認してください。');
    const work = Promise.resolve().then(operation);
    this.locks.set(id, work);
    try { return await work; } finally { this.locks.delete(id); }
  }

  async choose(context, customId, messageId) {
    if (!this.config.decisionButtons || !this.authorized(context)) throw new Error('この回答は許可されていません。');
    const match = /^rigpick:([a-f0-9]{24}):([0-3])$/.exec(customId);
    const entry = match && this.entries[match[1]];
    if (!entry || entry.messageId !== messageId) throw new Error('質問メッセージが一致しません。');
    return this.locked(entry.qitemId, async () => {
      if (entry.phase !== 'open') throw new Error('この質問は回答済み、送信中、または受付終了です。');
      const option = entry.question.options[Number(match[2])];
      if (!option) throw new Error('選択肢が存在しません。');
      const row = await this.rig.show(entry.qitemId);
      if (!this.eligible(row) || decisionVersion(row) !== entry.version || row.state !== 'pending' || this.expired(row) || own(row.humanAnswers, entry.question.id)) {
        entry.phase = 'closed'; this.store.save();
        await this.refresh(entry);
        throw new Error('質問は更新・回答・終了されています。新しい質問を確認してください。');
      }
      entry.pendingAnswer = { qitemId: entry.qitemId, questionId: entry.question.id, optionId: option.id,
        actorSession: this.config.decisionRecipient, userId: context.userId, interactionId: context.interactionId };
      entry.answerLabel = option.label;
      entry.phase = 'answer-pending';
      this.store.save();
      try {
        const recorded = await this.sendAnswer(entry);
        if (!recorded) return '質問の状態が変わったため、新しい回答は送信しませんでした。最新の質問を確認してください。';
        return `「${safeText(option.label)}」をOpenRigへ記録しました。全設問に回答すると統括役へ返ります。`;
      } catch (error) {
        this.log(`Decision answer pending ${entry.qitemId}: ${safeText(error.message).slice(0, 300)}`);
        if (entry.phase === 'answered') return `「${safeText(option.label)}」はOpenRigへ記録済みです。ボタンの表示を更新しています。`;
        try { await this.refresh(entry); } catch { /* Monitor retries UI updates. */ }
        return '回答を保存しました。OpenRigへの送信結果を再確認しています。同じボタンを押し直す必要はありません。';
      }
    });
  }

  async sendAnswer(entry) {
    const row = await this.rig.show(entry.qitemId);
    const selected = entry.pendingAnswer;
    const current = row.humanAnswers?.[entry.question.id];
    if (!this.eligible(row) || decisionVersion(row) !== entry.version || this.expired(row) ||
        (own(row.humanAnswers, entry.question.id) && current !== selected.optionId) ||
        (row.state !== 'pending' && !(row.state === 'done' && current === selected.optionId))) {
      entry.phase = 'closed'; delete entry.pendingAnswer; this.store.save(); await this.refresh(entry); return false;
    }
    const result = await this.rig.answer(selected);
    entry.phase = 'answered';
    entry.replyId = result.createdQitemId ?? null;
    delete entry.pendingAnswer;
    this.store.save();
    await this.refresh(entry);
    return true;
  }

  async refresh(entry) {
    if (!entry.messageId) return;
    const card = decisionCard(entry);
    const signature = JSON.stringify(card);
    if (entry.rendered === signature) return;
    await this.transport.editDecision(entry, card);
    entry.rendered = signature;
    this.store.save();
  }

  async poll() {
    if (!this.config.decisionButtons || this.polling) return;
    this.polling = true;
    try {
      for (const entry of Object.values(this.entries)) {
        try {
          if (entry.phase === 'answer-pending' && !this.locks.has(entry.qitemId)) {
            await this.locked(entry.qitemId, () => this.sendAnswer(entry));
          } else if (entry.phase !== 'open') await this.refresh(entry);
        } catch (error) { this.log(`Decision retry ${entry.qitemId}: ${safeText(error.message).slice(0, 300)}`); }
      }
      const rows = await this.rig.questions(this.config.destination, this.config.decisionRecipient);
      const active = new Set();
      for (const row of rows) {
        if (!this.eligible(row) || row.state !== 'pending' || this.expired(row)) continue;
        for (const question of row.humanQuestions) {
          const key = decisionKey(row, question);
          active.add(key);
          let entry = this.entries[key];
          if (!entry) {
            entry = this.entries[key] = { key, qitemId: row.qitemId, version: decisionVersion(row),
              question, summary: row.summary, body: row.body, evidenceRef: row.evidenceRef,
              includeBrief: question.id === row.humanQuestions[0].id, phase: 'open' };
            this.store.save();
          }
          if (own(row.humanAnswers, question.id) && entry.phase === 'open') {
            entry.phase = 'answered';
            const value = row.humanAnswers[question.id];
            entry.answerLabel = question.options.find(option => option.id === value)?.label ?? 'PC側で回答済み';
            this.store.save();
          }
          await this.transport.ensureDecision(entry, decisionCard(entry), () => this.store.save());
          await this.refresh(entry);
        }
      }
      for (const entry of Object.values(this.entries)) {
        if (entry.phase === 'open' && !active.has(entry.key) && rows.length < 100) {
          entry.phase = 'closed'; this.store.save(); await this.refresh(entry);
        }
      }
    } catch (error) { this.log(`Decision monitor: ${safeText(error.message).slice(0, 400)}`); }
    finally { this.polling = false; }
  }
}

export async function handleDecisionInteraction(interaction, decisions, contextOf, log = console.error) {
  if (!interaction.isButton() || !interaction.customId.startsWith('rigpick:')) return false;
  const context = contextOf(interaction);
  if (!decisions.authorized(context)) {
    await interaction.reply({ content: 'この回答ボタンは指定された本人専用です。', flags: 64 });
    return true;
  }
  await interaction.deferReply({ flags: 64 });
  try {
    const text = await decisions.choose(context, interaction.customId, interaction.message.id);
    await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
  } catch (error) {
    log(`Decision click: ${safeText(error.message).slice(0, 300)}`);
    await interaction.editReply({ content: safeText(error.message).slice(0, 1500), allowedMentions: { parse: [] } });
  }
  return true;
}
