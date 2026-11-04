import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, snapshot, safeText } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { RigClient, parseJsonOutput } from '../src/rig.js';
import { validateConfig } from '../src/config.js';
import { commandDefinition, chunks, allowedMentions, handleInteraction } from '../src/discord.js';

const config = {
  guildId: '100000000000000001', channelId: '100000000000000002',
  allowedUserIds: ['100000000000000003'], destination: 'orch-lead@myteam',
  rigName: 'myteam', pollSeconds: 15, maxActiveTasks: 20,
};
const context = { guildId: config.guildId, channelId: config.channelId,
  userId: config.allowedUserIds[0], interactionId: '100000000000000004' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-bridge-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  const rows = new Map();
  const notes = new Map();
  const created = [];
  const messages = [];
  const rig = {
    seats: async () => [{ canonicalSessionName: config.destination, sessionStatus: 'running' }],
    create: async input => {
      created.push(input);
      const row = rows.get(input.id) ?? { qitemId: input.id, state: 'pending',
        destinationSession: input.destination, summary: input.summary, resolution: null };
      rows.set(input.id, row);
      return row;
    },
    show: async id => { if (!rows.has(id)) throw new Error('Unknown task'); return rows.get(id); },
    transitions: async id => notes.get(id) ?? [],
  };
  const transport = {
    ensureThread: async (job, persist) => { job.anchorId = '100000000000000005'; persist(); job.threadId = job.anchorId; persist(); },
    notify: async (job, event) => messages.push({ thread: job.threadId, ...event }),
  };
  const bridge = new Bridge({ config, store, rig, transport, log: () => {} });
  return { directory, store, rig, transport, bridge, rows, notes, created, messages };
}

test('only the configured user, server and channel can submit or read tasks', async t => {
  const f = fixture(t);
  for (const changed of [{ userId: '100000000000000006' }, { guildId: '100000000000000007' },
    { channelId: '100000000000000008' }]) {
    await assert.rejects(f.bridge.submit({ ...context, ...changed }, 'test'));
    assert.equal(f.bridge.authorize({ ...context, ...changed }), false);
  }
  assert.equal(f.created.length, 0);
  const job = await f.bridge.submit(context, '要件を整理して');
  const threadContext = { ...context, channelId: job.threadId, parentId: config.channelId };
  assert.equal(f.bridge.authorize(threadContext), true);
  assert.equal(f.bridge.authorize({ ...threadContext, userId: '100000000000000006' }), false);
  assert.throws(() => f.bridge.findJob(context, 'qitem-an-unrelated-private-task'));
});

test('one interaction creates one durable task and requests only the existing lead', async t => {
  const f = fixture(t);
  const [first, duplicate] = await Promise.all([
    f.bridge.submit(context, '$(touch /tmp/no) & whoami'), f.bridge.submit(context, '$(touch /tmp/no) & whoami'),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].destination, config.destination);
  assert.match(f.created[0].body, /\$\(touch \/tmp\/no\)/);
  await f.bridge.submit(context, 'ignored duplicate');
  assert.equal(f.created.length, 1);
  assert.equal(new Store(f.directory).job(first.id).threadId, first.threadId);
});

test('monitor does not duplicate creation while a request is being delivered', async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.transport.ensureThread = async job => { await gate; job.threadId = '100000000000000005'; };
  const submission = f.bridge.submit(context, 'test');
  await new Promise(resolve => setImmediate(resolve));
  const poll = f.bridge.poll();
  release();
  await Promise.all([submission, poll]);
  assert.equal(f.created.length, 1);
});

test('uncertain create resumes with identical id and content after restart', async t => {
  const f = fixture(t);
  const realCreate = f.rig.create;
  f.rig.create = async input => { await realCreate(input); throw new Error('timeout after commit'); };
  await assert.rejects(f.bridge.submit(context, '計画して'), /timeout/);
  const original = f.created[0];
  const recovered = new Bridge({ config, store: new Store(f.directory), rig: { ...f.rig, create: realCreate },
    transport: f.transport, log: () => {} });
  await recovered.poll();
  assert.equal(f.rows.size, 1);
  assert.deepEqual(f.created[1], original);
  assert.equal(recovered.store.job(original.id).phase, 'active');
});

test('handoff is followed and is never reported as final success by itself', async t => {
  const f = fixture(t);
  const job = await f.bridge.submit(context, 'request');
  f.rows.set(job.id, { ...f.rows.get(job.id), state: 'handed-off', handedOffTo: 'qitem-next' });
  f.rows.set('qitem-next', { qitemId: 'qitem-next', state: 'in-progress', destinationSession: 'dev-lead@myteam' });
  await f.bridge.poll();
  assert.equal(job.phase, 'active');
  assert.match(f.messages.at(-1).text, /作業中/);
  f.rows.get('qitem-next').state = 'done';
  f.rows.get('qitem-next').resolution = '検証済み。SPEC.mdを作成。';
  await f.bridge.poll();
  assert.equal(job.phase, 'finished');
  assert.match(f.messages.at(-1).text, /検証済み/);
  assert.equal(f.messages.at(-1).thread, job.threadId);
  const count = f.messages.length;
  await f.bridge.poll();
  assert.equal(f.messages.length, count);
});

test('unresolved handoff and cycles are not false completions', async t => {
  const f = fixture(t);
  f.rows.set('qitem-a', { qitemId: 'qitem-a', state: 'done', closureReason: 'handed_off_to', closureTarget: 'dev-lead@myteam' });
  assert.equal((await snapshot(f.rig, 'qitem-a')).complete, false);
  f.rows.get('qitem-a').handedOffTo = 'qitem-b';
  f.rows.set('qitem-b', { qitemId: 'qitem-b', state: 'handed-off', handedOffTo: 'qitem-a' });
  await assert.rejects(snapshot(f.rig, 'qitem-a'), /循環/);
});

test('changed progress is notified, unchanged state is quiet, failed delivery retries', async t => {
  const f = fixture(t);
  const job = await f.bridge.submit(context, 'request');
  await f.bridge.poll();
  await f.bridge.poll();
  assert.equal(f.messages.length, 1);
  f.notes.set(job.id, [
    { transitionId: 1, transitionNote: '設計書の確認を終えました。', actorSession: config.destination },
    { transitionId: 2, transitionNote: 'internal watchdog heartbeat', actorSession: 'watchdog@system' },
  ]);
  const notify = f.transport.notify;
  f.transport.notify = async () => { throw new Error('Discord disconnected'); };
  await f.bridge.poll();
  assert.ok(new Store(f.directory).job(job.id).pending);
  assert.equal(job.phase, 'active');
  f.transport.notify = notify;
  await f.bridge.poll();
  assert.equal(f.messages.length, 2);
  assert.match(f.messages.at(-1).text, /設計書/);
  assert.doesNotMatch(f.messages.at(-1).text, /watchdog/);
  assert.equal(job.pending, undefined);
});

test('additional answers are linked work, not automatic native approvals', async t => {
  const f = fixture(t);
  const job = await f.bridge.submit(context, 'request');
  const replyContext = { ...context, interactionId: '100000000000000009', channelId: job.threadId, parentId: config.channelId };
  await f.bridge.reply(replyContext, 'こちらを優先');
  await f.bridge.reply(replyContext, 'こちらを優先');
  assert.equal(f.created.length, 2);
  assert.equal(f.created[1].destination, config.destination);
  assert.match(f.created[1].body, new RegExp(job.id));
  assert.match(f.created[1].body, /自動承認ではない/);
});

test('stopped lead refuses new work without launching a team', async t => {
  const f = fixture(t);
  f.rig.seats = async () => [{ canonicalSessionName: config.destination, sessionStatus: 'exited' }];
  await assert.rejects(f.bridge.submit(context, 'request'), /起動していません/);
  assert.equal(f.store.jobs().length, 0);
});

test('rig adapter passes text in a private file, never interpolates a shell', async () => {
  let bodyFile;
  const client = new RigClient({ execute: async (command, args, options) => {
    assert.equal(command, 'rig');
    assert.equal(options.shell, false);
    assert.equal(args.includes('--full'), true);
    assert.equal(args.includes('$(cat secret)'), false);
    bodyFile = args[args.indexOf('--body-file') + 1];
    assert.equal(fs.readFileSync(bodyFile, 'utf8'), '$(cat secret)');
    return { stdout: JSON.stringify({ qitemId: 'qitem-test', state: 'pending' }) };
  } });
  await client.create({ id: 'qitem-test', userId: context.userId, destination: config.destination, summary: 'test', body: '$(cat secret)' });
  assert.equal(fs.existsSync(bodyFile), false);
  assert.deepEqual(parseJsonOutput('notice\n{"ok":true}'), { ok: true });
});

test('durable store refuses concurrent processes and invalid config fails closed', t => {
  const f = fixture(t);
  f.store.lock();
  assert.throws(() => new Store(f.directory).lock(), /既に起動/);
  f.store.unlock();
  assert.throws(() => validateConfig({ ...config, allowedUserIds: [] }), /allowedUserIds/);
  assert.throws(() => validateConfig({ ...config, destination: 'lead@another-rig' }), /宛先/);
});

test('Discord command schema, chunk bounds and mention restrictions', () => {
  const command = commandDefinition();
  assert.equal(command.name, 'rig');
  assert.deepEqual(command.options.map(option => option.name), ['request', 'status', 'result', 'reply']);
  assert.deepEqual(allowedMentions.parse, []);
  const text = 'あ😀'.repeat(4000);
  const pieces = chunks(text);
  assert.ok(pieces.every(piece => piece.length <= 1800));
  assert.equal(pieces.join(''), text);
  assert.equal(safeText('Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), '[credential removed]');
});

test('unauthorized Discord interactions never enter bridge execution', async () => {
  let response;
  let submitted = false;
  await handleInteraction({
    isChatInputCommand: () => true, commandName: 'rig', guildId: 'wrong', channelId: config.channelId,
    user: { id: context.userId }, id: context.interactionId,
    reply: async value => { response = value; },
  }, { authorize: () => false, submit: async () => { submitted = true; } });
  assert.equal(submitted, false);
  assert.match(response.content, /専用/);
});
