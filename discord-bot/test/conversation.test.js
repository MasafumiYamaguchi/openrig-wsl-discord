import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConversation, speech, ConversationRelay } from '../src/conversation.js';
import { Store } from '../src/store.js';

function assistant(id, text) {
  return { type: 'assistant', uuid: id, timestamp: '2026-11-04T06:31:10Z',
    message: { content: [{ type: 'text', text }] } };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-conversation-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(file, '');
  return { directory, file, source: { path: file, sessionId: 'test-session' } };
}

test('conversation forwards only visible assistant text, not user, tools, thinking or sidechains', () => {
  assert.equal(speech({ type: 'user', uuid: 'u', message: { content: 'private request' } }), null);
  assert.equal(speech({ ...assistant('a', 'child'), isSidechain: true }), null);
  assert.equal(speech({ type: 'api-request-blob', ...assistant('a', 'hidden'), type: 'api-request-blob' }), null);
  const record = assistant('a', '結果です。');
  record.message.content.unshift({ type: 'thinking', thinking: 'private reasoning' }, { type: 'tool_use', input: { secret: 'value' } });
  assert.equal(speech(record).text, '結果です。');
});

test('initial read replays one latest reply, then every new visible reply exactly once', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, [assistant('a', 'old'), assistant('b', 'latest')].map(JSON.stringify).join('\n') + '\n');
  const initial = await readConversation(f.source);
  assert.deepEqual(initial.events.map(item => item.id), ['b']);
  fs.appendFileSync(f.file, [assistant('c', 'next'), assistant('c', 'duplicate'), assistant('d', 'last')].map(JSON.stringify).join('\n') + '\n');
  const next = await readConversation(f.source, initial.cursor);
  assert.deepEqual(next.events.map(item => item.id), ['c', 'd']);
  assert.deepEqual((await readConversation(f.source, next.cursor)).events, []);
});

test('a partially written UTF-8 JSONL record is not consumed until its newline arrives', async t => {
  const f = fixture(t);
  const record = Buffer.from(JSON.stringify(assistant('a', '日本語😀')) + '\n');
  const split = record.indexOf(Buffer.from('日')) + 1;
  fs.writeFileSync(f.file, record.subarray(0, split));
  const first = await readConversation(f.source);
  assert.equal(first.cursor.offset, 0);
  assert.deepEqual(first.events, []);
  fs.appendFileSync(f.file, record.subarray(split));
  const next = await readConversation(f.source, first.cursor);
  assert.equal(next.events[0].text, '日本語😀');
  fs.truncateSync(f.file, 0);
  fs.writeFileSync(f.file, JSON.stringify(assistant('b', 'new')) + '\n');
  assert.equal((await readConversation(f.source, next.cursor)).events[0].id, 'b');
});

test('pending delivery and cursor survive restart and retry with the identical nonce', async t => {
  const f = fixture(t);
  const store = new Store(path.join(f.directory, 'state'));
  fs.writeFileSync(f.file, JSON.stringify(assistant('a', 'ご報告です。')) + '\n');
  const attempts = [];
  const config = { relayConversation: true, destination: 'orch-lead@myteam' };
  const relay = new ConversationRelay({ config, store, resolve: async () => f.source, log: () => {},
    transport: { notifyConversation: async event => { attempts.push(event); throw new Error('offline'); } } });
  await relay.poll();
  assert.equal(store.data.conversation.cursor, undefined);
  assert.equal(new Store(store.directory).data.conversation.pending.events.length, 1);
  const recovered = new Store(store.directory);
  const relay2 = new ConversationRelay({ config, store: recovered, resolve: async () => f.source, log: () => {},
    transport: { notifyConversation: async event => attempts.push(event) } });
  await relay2.poll();
  await relay2.poll();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.match(attempts[1].text, /ご報告です。/);
  assert.equal(recovered.data.conversation.pending, undefined);
  assert.ok(recovered.data.conversation.cursor.offset > 0);
});

test('disabled relay never reads or sends and concurrent polls do not duplicate posts', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify(assistant('a', 'hello')) + '\n');
  let calls = 0;
  let sent = 0;
  const config = { relayConversation: false, destination: 'orch-lead@myteam' };
  const relay = new ConversationRelay({ config, store: new Store(path.join(f.directory, 'state')),
    resolve: async () => { calls++; return f.source; }, transport: { notifyConversation: async () => { sent++; } } });
  await relay.poll();
  assert.equal(calls, 0);
  config.relayConversation = true;
  await Promise.all([relay.poll(), relay.poll()]);
  assert.equal(calls, 1);
  assert.equal(sent, 1);
});
