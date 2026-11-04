import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Decisions, decisionCard, validQuestions, handleDecisionInteraction } from '../src/decisions.js';
import { Store } from '../src/store.js';
import { RigClient } from '../src/rig.js';

const config = { guildId: '100000000000000001', channelId: '100000000000000002',
  allowedUserIds: ['100000000000000003'], destination: 'orch-lead@myteam',
  decisionButtons: true, decisionRecipient: 'human@kernel' };
const context = { guildId: config.guildId, channelId: config.channelId, userId: config.allowedUserIds[0],
  interactionId: '100000000000000010' };
const question = { id: 'direction', question: 'どちらで進めますか？', options: [
  { id: 'a', label: 'Aで進める', recommended: true }, { id: 'b', label: '今回は保留' }] };

function fixture(t, questions = [question]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-decision-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  const row = { qitemId: 'qitem-vote-test', sourceSession: config.destination, destinationSession: config.decisionRecipient,
    state: 'pending', humanIntent: 'decision', humanQuestions: structuredClone(questions), humanAnswers: {},
    summary: '本人の選択が必要', body: 'Aの効果とBの影響を説明します。', evidenceRef: 'DECISIONS.md', expiresAt: null };
  const answers = [];
  const posted = [];
  const edits = [];
  const rig = { questions: async () => row.state === 'pending' ? [structuredClone(row)] : [],
    show: async () => structuredClone(row),
    answer: async input => {
      answers.push(input);
      row.humanAnswers[input.questionId] = input.optionId;
      if (row.humanQuestions.every(q => Object.hasOwn(row.humanAnswers, q.id))) row.state = 'done';
      return { createdQitemId: row.state === 'done' ? 'qitem-native-answer' : null };
    } };
  const transport = {
    ensureDecision: async (entry, card, persist) => {
      if (!entry.messageId) { posted.push(card); entry.messageId = String(100000000000000011n + BigInt(posted.length)); persist(); }
    },
    editDecision: async (entry, card) => edits.push({ key: entry.key, ...card }),
  };
  const service = new Decisions({ config, store, rig, transport, log: () => {} });
  return { directory, store, row, rig, answers, posted, edits, transport, service,
    entry: () => Object.values(service.entries)[0] };
}

const customId = (entry, index = 0) => `rigpick:${entry.key}:${index}`;

test('native question schema rejects malformed choices and arbitrary agent-only requests', async t => {
  assert.equal(validQuestions([question]), true);
  assert.equal(validQuestions([{ ...question, options: [question.options[0]] }]), false);
  assert.equal(validQuestions([{ ...question, id: 'bad/id' }]), false);
  assert.equal(validQuestions([{ ...question, options: [question.options[0], question.options[0]] }]), false);
  const f = fixture(t);
  f.row.sourceSession = 'dev-lead@myteam';
  await f.service.poll(); assert.equal(f.posted.length, 0);
  f.row.sourceSession = config.destination;
  f.row.destinationSession = 'human-other@kernel';
  await f.service.poll(); assert.equal(f.posted.length, 0);
  f.row.destinationSession = config.decisionRecipient;
  f.row.humanIntent = 'update';
  await f.service.poll(); assert.equal(f.posted.length, 0);
});

test('one question posts once, authentic click records exact choice and disables buttons', async t => {
  const f = fixture(t);
  await f.service.poll(); await f.service.poll();
  assert.equal(f.posted.length, 1);
  const entry = f.entry();
  const response = await f.service.choose(context, customId(entry, 1), entry.messageId);
  assert.match(response, /今回は保留/);
  assert.deepEqual(f.answers[0], { qitemId: f.row.qitemId, questionId: question.id, optionId: 'b',
    actorSession: config.decisionRecipient, userId: context.userId, interactionId: context.interactionId });
  assert.equal(entry.phase, 'answered');
  assert.ok(decisionCard(entry).components[0].components.every(button => button.disabled));
  await assert.rejects(f.service.choose(context, customId(entry), entry.messageId), /回答済み/);
  assert.equal(f.answers.length, 1);
});

test('wrong user, guild, channel, message or option never records an answer', async t => {
  const f = fixture(t); await f.service.poll(); const entry = f.entry();
  for (const change of [{ userId: '100000000000000006' }, { guildId: '100000000000000007' }, { channelId: '100000000000000004' }]) {
    await assert.rejects(f.service.choose({ ...context, ...change }, customId(entry), entry.messageId));
  }
  await assert.rejects(f.service.choose(context, customId(entry), 'another-message'));
  await assert.rejects(f.service.choose(context, customId(entry, 3), entry.messageId));
  assert.equal(f.answers.length, 0);
});

test('updated, expired and PC-answered questions reject stale buttons', async t => {
  for (const mutate of [row => { row.body = '変更後の条件'; }, row => { row.expiresAt = '2000-01-01T00:00:00Z'; },
    row => { row.humanAnswers.direction = 'b'; }, row => { row.state = 'done'; }]) {
    const f = fixture(t); await f.service.poll(); const entry = f.entry(); mutate(f.row);
    await assert.rejects(f.service.choose(context, customId(entry), entry.messageId));
    assert.equal(f.answers.length, 0); assert.equal(entry.phase, 'closed');
  }
});

test('all questions remain separately correlated until native completion', async t => {
  const f = fixture(t, [question, { ...question, id: 'timing', question: 'いつ始めますか？' }]);
  await f.service.poll(); const [a, b] = Object.values(f.service.entries);
  await f.service.choose(context, customId(a), a.messageId);
  assert.equal(f.row.state, 'pending'); assert.equal(b.phase, 'open');
  await f.service.choose(context, customId(b, 1), b.messageId);
  assert.equal(f.row.state, 'done');
  assert.deepEqual(f.row.humanAnswers, { direction: 'a', timing: 'b' });
});

test('unknown committed outcome resumes the same native answer after restart without inventing another choice', async t => {
  const f = fixture(t); await f.service.poll(); const entry = f.entry();
  const answer = f.rig.answer;
  f.rig.answer = async input => { await answer(input); throw new Error('response lost'); };
  await f.service.choose(context, customId(entry), entry.messageId);
  assert.equal(entry.phase, 'answer-pending');
  assert.equal(f.row.state, 'done');
  const recovered = new Decisions({ config, store: new Store(f.directory), rig: { ...f.rig, answer }, transport: f.transport, log: () => {} });
  await recovered.poll();
  assert.equal(recovered.entries[entry.key].phase, 'answered');
  assert.deepEqual(f.answers[0], f.answers[1]);
  await recovered.poll(); assert.equal(f.answers.length, 2);
});

test('a different PC answer during a failed delivery is preserved', async t => {
  const f = fixture(t); await f.service.poll(); const entry = f.entry();
  f.rig.answer = async () => { throw new Error('offline'); };
  await f.service.choose(context, customId(entry), entry.messageId);
  f.row.humanAnswers.direction = 'b';
  await f.service.poll();
  assert.equal(entry.phase, 'closed');
  assert.equal(f.row.humanAnswers.direction, 'b');
  assert.equal(f.answers.length, 0);
});

test('concurrent clicks are serialized per request and changed schema receives new IDs', async t => {
  const f = fixture(t); await f.service.poll(); const entry = f.entry();
  const result = await Promise.allSettled([f.service.choose(context, customId(entry), entry.messageId),
    f.service.choose(context, customId(entry, 1), entry.messageId)]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(f.answers.length, 1);
  f.row.state = 'pending'; f.row.humanAnswers = {}; f.row.body = '新しい判断条件';
  await f.service.poll();
  assert.equal(f.posted.length, 2);
  assert.equal(Object.values(f.service.entries).filter(item => item.phase === 'open').length, 1);
});

test('button interaction authenticates before deferring and does not execute unauthorized choices', async () => {
  let response; let called = false;
  const interaction = { isButton: () => true, customId: 'rigpick:test:0',
    reply: async value => { response = value; } };
  assert.equal(await handleDecisionInteraction(interaction, { authorized: () => false, choose: async () => { called = true; } }, () => ({})), true);
  assert.equal(response.flags, 64); assert.equal(called, false);
});

test('native answer adapter uses a private file, a fixed helper and shell:false', async () => {
  let file;
  const input = { qitemId: 'qitem-test', questionId: 'direction', optionId: 'a', actorSession: 'human@kernel',
    userId: context.userId, interactionId: context.interactionId };
  const client = new RigClient({ execute: async (command, args, options) => {
    assert.equal(command, process.execPath); assert.equal(options.shell, false);
    assert.match(args[0], /rig-answer\.js$/); file = args[1];
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), input);
    assert.equal(options.env.OPENRIG_SESSION_NAME, undefined);
    return { stdout: '{"createdQitemId":"qitem-native-answer"}' };
  } });
  assert.equal((await client.answer(input)).createdQitemId, 'qitem-native-answer');
  assert.equal(fs.existsSync(file), false);
});
