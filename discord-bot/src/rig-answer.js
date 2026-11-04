// A narrow adapter to OpenRig's shipped Mission Control answer contract.
// No generic endpoint or action verb is accepted from Discord.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

try {
  for (const key of Object.keys(process.env)) if (/^(OPENRIG|RIGGED)_(NODE_ID|SESSION_NAME|RIG_ID|POD_ID|MEMBER_ID|OCCUPANT_GENERATION)$/.test(key)) delete process.env[key];
  const root = process.env.BRIDGE_OPENRIG_CLI_ROOT ?? path.join(os.homedir(), '.local/lib/node_modules/@openrig/cli');
  const load = relative => import(pathToFileURL(path.join(root, relative)).href);
  const [{ DaemonClient }, { getDaemonStatus, getDaemonUrl, daemonStatusGuard }, { realDeps }] = await Promise.all([
    load('dist/client.js'), load('dist/daemon-lifecycle.js'), load('dist/commands/daemon.js'),
  ]);
  const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  if (!/^qitem-[A-Za-z0-9_-]+$/.test(input.qitemId) || !/^[A-Za-z0-9_-]{1,40}$/.test(input.questionId) ||
      !/^[A-Za-z0-9_-]{1,40}$/.test(input.optionId) || !/^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/.test(input.actorSession) ||
      !/^\d{17,22}$/.test(input.userId) || !/^\d{17,22}$/.test(input.interactionId)) throw new Error('Invalid decision answer identifiers.');
  const status = await getDaemonStatus(realDeps());
  if (!daemonStatusGuard(status)) throw new Error('OpenRig daemon is unavailable.');
  const client = new DaemonClient(getDaemonUrl(status));
  const bearer = process.env.OPENRIG_AUTH_BEARER_TOKEN;
  const result = await client.post('/api/mission-control/action', {
    verb: 'answer', qitemId: input.qitemId, questionId: input.questionId, optionId: input.optionId,
    actorSession: input.actorSession,
    auditNotes: `Discord本人のボタン回答: user=${input.userId}; interaction=${input.interactionId}`,
  }, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined);
  if (result.status >= 400) throw new Error(`OpenRig answer HTTP ${result.status}: ${result.data.message ?? result.data.error ?? 'refused'}`);
  console.log(JSON.stringify(result.data));
} catch (error) {
  // SDK bodies and tokens must never reach logs.
  console.error(String(error.message).replace(/Bearer\s+\S+/gi, '[credential removed]').slice(0, 800));
  process.exitCode = 1;
}
