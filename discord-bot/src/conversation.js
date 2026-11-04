import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { nonceFor, safeText } from './bridge.js';

const execute = promisify(execFile);
const readLimit = 8 * 1024 * 1024;

export async function resolveConversation(seat) {
  const { stdout } = await execute('python3', [fileURLToPath(new URL('./resolve-conversation.py', import.meta.url)), seat],
    { shell: false, timeout: 10000, maxBuffer: 65536 });
  const source = JSON.parse(stdout);
  if (typeof source.path !== 'string' || typeof source.sessionId !== 'string') throw new Error('会話の取得先が不正です。');
  return source;
}

export function speech(record) {
  if (record.type !== 'assistant' || record.isSidechain || typeof record.uuid !== 'string') return null;
  const content = record.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content.filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n').trim();
  return text ? { id: record.uuid, text: safeText(text), timestamp: record.timestamp } : null;
}

export async function readConversation(source, previous) {
  const file = await fs.open(source.path, 'r');
  try {
    const stat = await file.stat();
    const identity = `${source.sessionId}:${stat.dev}:${stat.ino}`;
    const fresh = !previous || previous.identity !== identity || previous.offset > stat.size;
    const start = fresh ? Math.max(0, stat.size - readLimit) : previous.offset;
    const length = Math.min(readLimit, stat.size - start);
    const data = Buffer.alloc(length);
    const { bytesRead } = await file.read(data, 0, length, start);
    const buffer = data.subarray(0, bytesRead);
    const end = buffer.lastIndexOf(10);
    if (end < 0) {
      if (length === readLimit) throw new Error('会話履歴の1行が読取上限を超えています。');
      return { cursor: { identity, offset: start }, events: [] };
    }
    const first = fresh && start > 0 ? buffer.indexOf(10) + 1 : 0;
    const events = [];
    const seen = new Set();
    for (const line of buffer.subarray(first, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const event = speech(JSON.parse(line));
      if (event && !seen.has(event.id)) { events.push(event); seen.add(event.id); }
    }
    return { cursor: { identity, offset: start + end + 1 }, events: fresh ? events.slice(-1) : events };
  } finally { await file.close(); }
}

export class ConversationRelay {
  constructor({ config, store, transport, resolve = resolveConversation, read = readConversation, log = console.error }) {
    Object.assign(this, { config, store, transport, resolve, read, log });
    this.polling = false;
  }

  async poll() {
    if (this.polling || !this.config.relayConversation) return;
    this.polling = true;
    try {
      const state = this.store.data.conversation ??= { delivered: [] };
      if (!state.pending) {
        const source = await this.resolve(this.config.destination);
        const batch = await this.read(source, state.cursor);
        state.pending = { ...batch, sessionId: source.sessionId };
        this.store.save();
      }
      for (const event of state.pending.events) {
        const key = `${state.pending.sessionId}:${event.id}`;
        if (state.delivered.includes(key)) continue;
        const timestamp = event.timestamp && !Number.isNaN(Date.parse(event.timestamp))
          ? new Date(event.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';
        const body = event.text.length > 24000 ? `${event.text.slice(0, 23500)}\n（長文のため省略。全文はPC側の統括役の会話で確認できます。）` : event.text;
        await this.transport.notifyConversation({ text: `統括役｜${this.config.destination}${timestamp ? `｜${timestamp} JST` : ''}\n\n${body}`,
          nonce: nonceFor(`conversation:${key}`) });
        state.delivered = [...state.delivered, key].slice(-512);
        this.store.save();
      }
      state.cursor = state.pending.cursor;
      delete state.pending;
      delete state.lastError;
      this.store.save();
    } catch (error) {
      const message = safeText(error.message).slice(0, 400);
      const state = this.store.data.conversation ??= { delivered: [] };
      if (state.lastError !== message) this.log(`Conversation relay: ${message}`);
      state.lastError = message;
      this.store.save();
    } finally { this.polling = false; }
  }
}
