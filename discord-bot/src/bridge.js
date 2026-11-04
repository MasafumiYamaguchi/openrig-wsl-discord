import crypto from 'node:crypto';

const terminalStates = new Set(['done', 'failed', 'denied', 'canceled']);
const labels = { pending: '受付済み', 'in-progress': '作業中', blocked: '確認・依存作業待ち',
  done: '完了', failed: '失敗', denied: '却下', canceled: '取消', 'handed-off': '引き継ぎ中' };

export function safeText(value) {
  return String(value ?? '')
    .replace(/(?:xox[baprs]-|sk-)[A-Za-z0-9_-]{16,}/g, '[secret removed]')
    .replace(/(?:Bot|Bearer)\s+[A-Za-z0-9_.-]{20,}/gi, '[credential removed]')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, '[token removed]');
}

export function nonceFor(value) {
  return BigInt(`0x${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`).toString();
}

function handoff(row) {
  if (row.state !== 'handed-off' && !(row.state === 'done' && row.closureReason === 'handed_off_to')) return null;
  const candidate = row.handedOffTo ?? row.closureTarget;
  return typeof candidate === 'string' && /^qitem-[a-zA-Z0-9_-]+$/.test(candidate) ? candidate : undefined;
}

export async function snapshot(rig, rootId) {
  const chain = [];
  let id = rootId;
  const seen = new Set();
  for (let depth = 0; depth < 20; depth++) {
    if (seen.has(id)) throw new Error('OpenRigの引き継ぎが循環しています。');
    seen.add(id);
    const row = await rig.show(id);
    chain.push(row);
    const next = handoff(row);
    if (next === undefined) return { row, chain, complete: false, note: '引き継ぎ先の作業IDが未確認です。' };
    if (next) { id = next; continue; }
    const transitions = await rig.transitions(id);
    const notes = transitions.map(item => ({ ...item, note: item.transitionNote ?? item.note }))
      .filter(item => typeof item.note === 'string' && item.note.trim() &&
        !/^(watchdog|daemon|system)(@|$)/.test(item.actorSession ?? ''));
    const latest = notes.at(-1);
    return { row, chain, complete: terminalStates.has(row.state), note: latest?.note ?? '',
      noteId: latest?.transitionId ?? latest?.id ?? latest?.ts ?? latest?.tsCreated ?? latest?.note ?? null };
  }
  throw new Error('引き継ぎが20段を超えたため追跡を停止しました。');
}

export function renderSnapshot(view) {
  const row = view.row;
  const parts = [`${labels[row.state] ?? row.state}｜${row.qitemId}`, `担当：${row.destinationSession ?? '未確認'}`];
  if (view.chain.length > 1) parts.push(`引き継ぎ：${view.chain.map(item => item.qitemId).join(' → ')}`);
  if (row.summary) parts.push(safeText(row.summary));
  if (row.blockedOn) parts.push(`待ち先：${safeText(row.blockedOn)}`);
  if (view.complete) parts.push(safeText(row.resolution || '状態は終了ですが、結果本文はまだ記録されていません。'));
  else if (view.note) parts.push(safeText(view.note));
  return parts.join('\n');
}

export function taskBody(job, destination) {
  return [
    'Discordからの本人の依頼。既存のチーム編成・モデル・権限・プロジェクトの規約を維持する。',
    `宛先: ${destination}`, `依頼ID: ${job.id}`, `依頼者Discord ID: ${job.userId}`,
    `Discordスレッド: https://discord.com/channels/${job.guildId}/${job.threadId}`,
    '', '【返信の記録方法】',
    'このqitemをclaimして通常の担当分けを行う。進捗や質問はこのqitemにqueue update --noteで残す。',
    'Botがこの依頼・明示的なhandoff先の状態とメモを同じDiscordスレッドへ中継する。',
    '完了時はqueue updateでstate=done、closure-reason=no-follow-on、resolutionに本人向けの結果・検証・残件を記録する。',
    '別qitemへ引き継ぐ場合はqueue handoffを使い関係を記録する。引き継ぎを成果の完成として扱わない。',
    'このBotはnative permission promptを承認しない。権限確認が必要ならその操作を明示して本人へ知らせる。',
    'Discordから追加回答が来ると、元の依頼IDを記した別qitemとしてこの統括役に届く。',
    '本人へ選択を求めるときは、human@kernel宛てのqitemをhumanQuestions付きで作る（rig queue create --destination human@kernel --human-questions-file JSONファイル --summary 要約 --body-file 判断に必要な説明 --evidence-ref 判断資料）。1〜4問、各2〜4択。Discordが選択ボタンを表示し、本人のクリックをOpenRig標準answer経路で記録する。全問回答後に元の質問を閉じて、この統括役へ回答qitemが返る。通常の文章だけの質問やnative権限確認はボタンにならない。',
    'プロジェクト外の秘密情報や関係ない作業内容を返信に含めない。Discordには本文だけが送信され、ローカルファイルは自動添付されない。',
    '', '【本人の依頼本文】', job.text,
  ].join('\n');
}

export class Bridge {
  constructor({ config, store, rig, transport, log = console.error }) {
    Object.assign(this, { config, store, rig, transport, log });
    this.inflight = new Map();
    this.deliveries = new Map();
    this.polling = false;
  }

  authorize(context) {
    return context.guildId === this.config.guildId && this.config.allowedUserIds.includes(context.userId) &&
      (context.channelId === this.config.channelId ||
       (context.parentId === this.config.channelId && this.store.byThread(context.channelId)?.userId === context.userId));
  }

  findJob(context, id) {
    const job = id ? this.store.job(id) : this.store.byThread(context.channelId);
    if (!job || job.userId !== context.userId || job.guildId !== context.guildId || job.channelId !== this.config.channelId) {
      throw new Error('この依頼は見つかりません。依頼スレッド内で実行するか、作業IDを指定してください。');
    }
    return job;
  }

  async submit(context, text) {
    if (!this.authorize(context) || context.channelId !== this.config.channelId) throw new Error('指定された依頼チャンネルで実行してください。');
    if (!text?.trim() || text.length > 4000) throw new Error('依頼は1〜4000文字で入力してください。');
    if (!/^\d{17,22}$/.test(context.interactionId)) throw new Error('Discord操作IDが不正です。');
    const id = `qitem-discord-${context.interactionId}`;
    if (this.inflight.has(id)) return this.inflight.get(id);
    const work = this.prepare(context, text.trim(), id);
    this.inflight.set(id, work);
    try { return await work; } finally { this.inflight.delete(id); }
  }

  async prepare(context, text, id) {
    let job = this.store.job(id);
    if (!job) {
      if (this.store.jobs().filter(item => item.phase !== 'finished').length >= this.config.maxActiveTasks) {
        throw new Error('同時受付の上限です。進行中の依頼を確認してください。');
      }
      const seats = await this.rig.seats(this.config.rigName);
      const seat = seats.find(item => item.canonicalSessionName === this.config.destination);
      if (!seat || seat.sessionStatus !== 'running') throw new Error('統括役が起動していません。PC側で既存チームを確認してください。');
      job = this.store.put({ id, userId: context.userId, guildId: context.guildId,
        channelId: this.config.channelId, interactionId: context.interactionId, text,
        createdAt: new Date().toISOString(), phase: 'preparing' });
    }
    return this.deliver(job);
  }

  async deliver(job) {
    if (this.deliveries.has(job.id)) return this.deliveries.get(job.id);
    const work = this.deliverNow(job);
    this.deliveries.set(job.id, work);
    try { return await work; } finally { this.deliveries.delete(job.id); }
  }

  async deliverNow(job) {
    if (job.phase !== 'preparing') return job;
    if (!job.threadId) {
      await this.transport.ensureThread(job, () => this.store.put(job));
      this.store.put(job);
    }
    // Retry the same create ID after an uncertain CLI result; never mint another ID.
    await this.rig.create({ id: job.id, userId: job.userId, destination: this.config.destination,
      summary: `Discord依頼: ${job.text.replace(/\s+/g, ' ').slice(0, 100)}`, body: taskBody(job, this.config.destination) });
    job.phase = 'active';
    this.store.put(job);
    return job;
  }

  async reply(context, text, taskId) {
    if (!this.authorize(context)) throw new Error('この操作は許可されていません。');
    if (!text?.trim() || text.length > 4000) throw new Error('回答は1〜4000文字で入力してください。');
    const job = this.findJob(context, taskId);
    const id = `qitem-discord-${context.interactionId}`;
    if (this.store.data.replies[id]) return id;
    const body = [`Discordで本人から元依頼 ${job.id} への追加回答が届いた。`,
      `元の依頼のスレッド: https://discord.com/channels/${job.guildId}/${job.threadId}`,
      '元依頼・引き継ぎ先の現状を確認して扱うこと。これはnative権限プロンプトの自動承認ではない。',
      'この回答qitemの終了だけで元依頼を完了にしない。元依頼側に本人向けの進捗・結果を記録する。', '', text.trim()].join('\n');
    await this.rig.create({ id, userId: context.userId, destination: this.config.destination,
      summary: `Discord追加回答: ${job.id}`, body });
    this.store.data.replies[id] = { taskId: job.id, at: new Date().toISOString() };
    this.store.save();
    return id;
  }

  async status(context, taskId) {
    if (!this.authorize(context)) throw new Error('この操作は許可されていません。');
    if (taskId || this.store.byThread(context.channelId)) {
      const job = this.findJob(context, taskId);
      if (job.phase === 'preparing') return `OpenRigへの受付を再確認中です。作業ID：${job.id}`;
      return renderSnapshot(await snapshot(this.rig, job.id));
    }
    const jobs = this.store.jobs().filter(job => job.userId === context.userId).slice(-10).reverse();
    if (!jobs.length) return 'まだDiscordからの依頼はありません。/rig requestで依頼できます。';
    return jobs.map(job => `${job.id}｜${job.phase === 'finished' ? '終了' : '追跡中'}｜${safeText(job.text).slice(0, 100)}\nhttps://discord.com/channels/${job.guildId}/${job.threadId ?? job.channelId}`).join('\n\n');
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const job of this.store.jobs()) {
        if (job.phase === 'finished') continue;
        try {
          if (job.phase === 'preparing') await this.deliver(job);
          const view = await snapshot(this.rig, job.id);
          const rendered = renderSnapshot(view);
          const text = rendered.length <= 24000 ? rendered : `${rendered.slice(0, 23500)}\n\n（長文のため表示を省略。全文はPCの rig queue show ${view.row.qitemId} --full --json で確認できます。）`;
          const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
            id: view.row.qitemId, state: view.row.state, blockedOn: view.row.blockedOn,
            summary: view.row.summary, resolution: view.row.resolution, note: view.note, complete: view.complete,
          })).digest('hex');
          if (job.notified === fingerprint) continue;
          job.pending = { fingerprint, text, nonce: nonceFor(`${job.id}:${fingerprint}`), complete: view.complete };
          this.store.put(job);
          await this.transport.notify(job, job.pending);
          job.notified = fingerprint;
          if (view.complete) job.phase = 'finished';
          delete job.pending;
          delete job.lastError;
          this.store.put(job);
        } catch (error) {
          const detail = safeText(error.message).slice(0, 400);
          if (job.lastError !== detail) this.log(`Task ${job.id}: ${detail}`);
          job.lastError = detail;
          this.store.put(job);
        }
      }
    } finally { this.polling = false; }
  }
}
