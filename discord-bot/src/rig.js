import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executeFile = promisify(execFile);

export function parseJsonOutput(output) {
  const text = output.trim();
  try { return JSON.parse(text); } catch { /* Some CLI versions print a preamble. */ }
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '{' && text[index] !== '[') continue;
    try { return JSON.parse(text.slice(index)); } catch { /* Try the next boundary. */ }
  }
  throw new Error('OpenRigの応答をJSONとして読めませんでした。');
}

export function unwrapRow(value) {
  const row = value?.qitem ?? value?.item ?? value;
  if (!row || typeof row.qitemId !== 'string' || typeof row.state !== 'string') {
    throw new Error('OpenRigの作業レコードの形式が不明です。');
  }
  return row;
}

export class RigClient {
  constructor({ execute = executeFile, command = process.env.BRIDGE_RIG_COMMAND ?? 'rig' } = {}) {
    this.execute = execute;
    this.command = command;
  }

  async run(args, command = this.command) {
    const env = { ...process.env };
    // A bridge is an external sender, never the seat hosting its process.
    for (const key of Object.keys(env)) if (/^(OPENRIG|RIGGED)_(NODE_ID|SESSION_NAME|RIG_ID|POD_ID|MEMBER_ID|OCCUPANT_GENERATION)$/.test(key)) delete env[key];
    const { stdout } = await this.execute(command, args, {
      env, shell: false, timeout: 25000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    return parseJsonOutput(stdout);
  }

  async seats(rigName) {
    const value = await this.run(['ps', '--nodes', '--rig', rigName, '--json']);
    const entries = Array.isArray(value) ? value : value.entries;
    if (!Array.isArray(entries)) throw new Error('OpenRigの席一覧の形式が不明です。');
    return entries;
  }

  async show(id) { return unwrapRow(await this.run(['queue', 'show', id, '--full', '--json'])); }

  async questions(source, recipient) {
    const value = await this.run(['queue', 'list', '-A', '--source', source,
      '--destination', recipient, '--state', 'pending', '--limit', '100', '--full', '--json']);
    const rows = Array.isArray(value) ? value : value.items ?? value.entries;
    if (!Array.isArray(rows)) throw new Error('OpenRigの質問一覧の形式が不明です。');
    return rows;
  }

  async answer(input) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openrig-discord-answer-'));
    const file = path.join(directory, 'answer.json');
    try {
      await fs.writeFile(file, JSON.stringify(input), { mode: 0o600 });
      return await this.run([fileURLToPath(new URL('./rig-answer.js', import.meta.url)), file], process.execPath);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }

  async transitions(id) {
    const value = await this.run(['queue', 'transitions', id, '--full', '--json']);
    const rows = Array.isArray(value) ? value : value.transitions ?? value.entries;
    if (!Array.isArray(rows)) throw new Error('OpenRigの進捗履歴の形式が不明です。');
    return rows;
  }

  async create({ id, userId, destination, summary, body }) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openrig-discord-'));
    const file = path.join(directory, 'request.txt');
    try {
      await fs.writeFile(file, body, { mode: 0o600 });
      const value = await this.run(['queue', 'create', '--id', id,
        '--source', `discord-${userId}@external`, '--destination', destination,
        '--summary', summary, '--body-file', file, '--full', '--json']);
      const row = unwrapRow(value);
      if (row.qitemId !== id) throw new Error('OpenRigが別の作業IDを返しました。');
      return row;
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
}
