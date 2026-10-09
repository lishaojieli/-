import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { Configuration } from '../src/config.mjs';
import { RoomStore } from '../src/store.mjs';
import { executeCheck } from '../src/checks.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filesSnapshot } from '../src/evidence.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const deadline = Date.now() + 6000; while (Date.now() < deadline) { if (predicate()) return; await delay(5); } throw new Error('调度未达到预期状态'); }
const record = (task, additions = {}) => '实际测试成员回复\n```room-progress\n' + JSON.stringify({ taskRevision: task.taskRevision, completionClaim: false, evidenceRefs: [], progressItems: [], ...additions }) + '\n```';
async function fixture(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-room-scheduler-'));
  const config = new Configuration(directory, { codexPath: 'fake-codex', deepseekKey: 'fake-key', workspace: path.join(directory, 'workspace') }); config.resetStatus();
  let app; const calls = []; const tools = [];
  const providers = { close() {}, codex: { respond() {} }, run: async (author, prompt, parameters) => { calls.push({ author, prompt, ...parameters }); return run({ author, prompt, parameters, task: app.room.executionTask, app, calls, directory }); } };
  const schedulerOptions = { heartbeatMs: 10, ...options, tools: options.tools || { execute: async (check, workspace, signal) => { tools.push(check); if (signal.aborted) throw signal.reason; return { passed: true, detail: '假工具真实执行记录：测试断言通过', exitCode: 0, ref: JSON.stringify(check) }; } } };
  app = await createApp({ directory, configuration: config, providers, schedulerOptions, port: 0 });
  let url = await app.listen(); let cookie = (await fetch(url)).headers.get('set-cookie').split(';')[0];
  const request = async (route, input) => { const response = await fetch(url + route, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Room-Request': '1' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, body: await response.json() }; };
  const post = async (input = {}) => { const result = await request('/api/messages', { text: '请提供最终文案', mode: 'auto', ...input }); assert.equal(result.status, 202, JSON.stringify(result.body)); return result.body.taskId; };
  const stop = async () => { await until(() => !app.room.running); return app.room.current; };
  const restart = async () => { if (!app.room.closed) await app.close(); app = await createApp({ directory, configuration: config, providers, schedulerOptions, port: 0 }); url = await app.listen(); cookie = (await fetch(url)).headers.get('set-cookie').split(';')[0]; return app; };
  const close = async () => { await app.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^agent-room-scheduler-/); await rm(directory, { recursive: true, force: true }); };
  return { get app() { return app; }, directory, calls, tools, post, stop, restart, request, close };
}
function finalReview(task) { return { completionClaim: true, evidenceRefs: task.evidence.map(item => item.id), reviews: task.acceptance.map(item => ({ acceptanceId: item.id, verdict: 'pass', evidenceRefs: task.evidence.map(item => item.id), basis: '独立审阅了实际交付正文，逐项符合用户提出的范围与内容要求。' })) }; }

test('固定三轮保持成员周期，点名不会增加预算外调用', async () => {
  const f = await fixture(async () => '@Codex @DeepSeek 请继续讨论');
  try { await f.post({ mode: 'fixed', rounds: 3 }); const task = await f.stop(); assert.equal(f.calls.length, 6); assert.equal(task.run.rounds, 3); assert.equal(task.status, 'paused'); assert.equal(task.stopReason, 'fixed_rounds'); assert.equal(f.app.room.chat().scheduler.sessionRounds, 3); } finally { await f.close(); }
});
test('自动模式超过三轮，第五轮由独立验收判定完成', async () => {
  const f = await fixture(async ({ task, author }) => record(task, task.checkpoint.number === 5 && author === 'deepseek' ? finalReview(task) : { deliverables: [{ name: '最终文案', text: '成稿实际改动，第 ' + task.checkpoint.number + ' 轮，由 ' + author + ' 提交。' }] }));
  try { await f.post(); const task = await f.stop(); assert.equal(task.status, 'completed'); assert.equal(task.run.rounds, 5); assert.equal(task.stopReason, 'acceptance_complete'); assert.ok(task.acceptance.every(item => item.review && item.evidenceRefs.length)); } finally { await f.close(); }
});
test('连续两个完整周期空转暂停，改变话题或策略不能绕过', async () => {
  const f = await fixture(async ({ task, author }) => record(task, { nextStep: '换一个话题 ' + task.checkpoint.number + author, progressItems: [{ kind: 'new_fact', issueId: 'i', ref: '口头承诺', evidence: ['不存在'] }] }));
  try { await f.post(); const task = await f.stop(); assert.equal(task.stopReason, 'no_progress'); assert.equal(task.rounds.filter(item => item.complete).length, 2); assert.ok(task.rounds.every(item => !item.progressItems.length)); } finally { await f.close(); }
});
test('真实读码、交付变化和首次通过产生进展，重复登记不产生新进展', async () => {
  const f = await fixture(async ({ task, author, parameters }) => {
    const round = task.checkpoint.number;
    if (round <= 2 && author === 'codex') { await writeFile(path.join(parameters.workspace, 'source.mjs'), 'export const value = ' + round); return record(task, { facts: [{ path: 'source.mjs' }] }); }
    if (round === 3 && author === 'codex') return record(task, { deliverables: [{ name: '说明', text: '这里是完整的用户文案成稿，包括所需范围与说明。' }] });
    if (round === 4 && author === 'deepseek') return record(task, finalReview(task));
    return record(task, round >= 2 ? { facts: [{ path: 'source.mjs' }] } : {});
  });
  try { await f.post(); const task = await f.stop(); assert.equal(task.status, 'completed'); assert.equal(task.run.rounds, 4); assert.ok(task.rounds[0].progressItems.some(item => item.kind === 'new_fact')); assert.ok(task.rounds[2].progressItems.some(item => item.kind === 'deliverable_changed')); assert.ok(task.rounds[3].progressItems.some(item => item.kind === 'acceptance_advanced')); } finally { await f.close(); }
});
test('只有自述、无证据及自身审阅都不能标记完成', async () => {
  const f = await fixture(async ({ task }) => record(task, { completionClaim: true, status: 'completed', acceptance: [], evidenceRefs: ['https://example.test/result'], reviews: [{ acceptanceId: 'accept-1', verdict: 'pass', evidenceRefs: ['https://example.test/result'], basis: '我已经完成全部任务所以无需检查。' }] }));
  try { await f.post(); const task = await f.stop(); assert.equal(task.status, 'paused'); assert.equal(task.acceptance.length, 1); assert.equal(task.acceptance[0].status, 'open'); } finally { await f.close(); }
});
test('代码任务必须具有真实修改与真实检查，成稿加自述测试通过不够', async () => {
  const f = await fixture(async ({ task, author }) => record(task, author === 'deepseek' && task.evidence.length ? finalReview(task) : { deliverables: [{ name: '计划', text: '已经修改代码和通过测试，第' + task.checkpoint.number + '轮' }] }));
  try { await f.post({ text: '实现代码并完成测试', budget: { runRounds: 4 } }); const task = await f.stop(); assert.equal(task.status, 'paused'); assert.equal(task.acceptance[0].status, 'open'); assert.equal(task.stopReason, 'no_progress'); } finally { await f.close(); }
});
test('真实调度工具检查关联验收，首次通过后结束；同目标检查去重', async () => {
  const f = await fixture(async ({ task, author, parameters }) => {
    if (author === 'codex') { await writeFile(path.join(parameters.workspace, 'result.mjs'), 'export const success = true;'); return record(task, { checkRequests: [{ acceptanceId: 'accept-1', check: { type: 'node', args: ['--check', 'result.mjs'] } }] }); }
    return record(task, task.checkpoint.number >= 3 ? finalReview(task) : {});
  });
  try { await f.post({ text: '实现代码并验证', target: 'codex_deepseek' }); const task = await f.stop(); assert.equal(task.status, 'completed'); assert.equal(f.tools.length, 1); assert.equal(task.run.rounds, 3); assert.equal(task.evidence.filter(item => item.kind === 'check').length, 1); } finally { await f.close(); }
});
test('长时间调用由真实计时预算暂停，不把未完成周期算空转', async () => {
  let finish; const f = await fixture(async ({ parameters }) => new Promise(resolve => { finish = resolve; parameters.signal.addEventListener('abort', () => resolve('迟到结果'), { once: true }); }));
  try { await f.post({ budget: { runActiveMs: 50 } }); await until(() => f.app.room.current.status === 'paused'); assert.equal(f.app.room.current.stopReason, 'budget'); assert.equal(f.app.room.current.noProgressRounds, 0); await f.stop(); assert.ok(f.app.room.chat().scheduler.sessionActiveMs >= 50); assert.ok(finish); } finally { await f.close(); }
});
test('单次和累计轮数分别生效，继续仅重置单次预算，累计额度需用户增加', async () => {
  const f = await fixture(async ({ task, author }) => record(task, { deliverables: [{ name: '稿件', text: `${task.run.id} ${task.checkpoint.number} ${author}` }] }));
  try {
    await f.post({ budget: { runRounds: 2, sessionRounds: 3 } }); let task = await f.stop(); assert.equal(task.run.rounds, 2); assert.equal(task.stopReason, 'budget');
    assert.equal((await f.request('/api/control', { action: 'resume' })).status, 200); task = await f.stop(); assert.equal(task.run.rounds, 1); assert.equal(f.app.room.chat().scheduler.sessionRounds, 3);
    assert.equal((await f.request('/api/control', { action: 'resume' })).status, 409);
    assert.equal((await f.request('/api/budget', { chatId: task.chatId, budget: { sessionRounds: 4 } })).status, 200);
    assert.equal((await f.request('/api/control', { action: 'resume' })).status, 200); await f.stop(); assert.equal(f.app.room.chat().scheduler.sessionRounds, 4);
  } finally { await f.close(); }
});
test('累计时间上限独立生效，暂停等待不消耗有效时间', async () => {
  let mono = 0; const f = await fixture(async ({ task }) => { mono += 35; return record(task, { deliverables: [{ name: '稿', text: String(mono) }] }); }, { clock: { mono: () => mono, wall: () => Date.now() } });
  try { await f.post({ budget: { runActiveMs: 1000, sessionActiveMs: 50 } }); await f.stop(); const before = f.app.room.chat().scheduler.sessionActiveMs; assert.ok(before >= 50); mono += 10000; await delay(30); assert.equal(f.app.room.chat().scheduler.sessionActiveMs, before); assert.equal((await f.request('/api/control', { action: 'resume' })).status, 409); } finally { await f.close(); }
});
test('读取状态、清缓存模拟、重启、新 runId 和继续都不能重置累计预算', async () => {
  const f = await fixture(async ({ task, author }) => record(task, { deliverables: [{ name: '稿', text: task.run.id + task.checkpoint.number + author }] }));
  try { await f.post({ budget: { runRounds: 2, sessionRounds: 5 } }); await f.stop(); const before = structuredClone(f.app.room.chat().scheduler); await f.request('/api/state'); await f.restart(); assert.equal(f.app.room.chat().scheduler.sessionRounds, before.sessionRounds); assert.equal(f.app.room.chat().scheduler.sessionActiveMs, before.sessionActiveMs); await f.request('/api/control', { action: 'resume' }); await f.stop(); assert.equal(f.app.room.chat().scheduler.sessionRounds, 4); const disk = JSON.parse(await readFile(path.join(f.directory, 'room.json'))); assert.equal(disk.chats[0].scheduler.reservations.length, 4); } finally { await f.close(); }
});
test('重复提交、重复工具回调、迟到回复不覆盖状态或重新调度', async () => {
  let finish; const f = await fixture(async ({ parameters }) => new Promise(resolve => { finish = () => { parameters.onDelta('不应写入'); parameters.onToolResult({ id: 'duplicate', type: 'commandExecution', status: 'completed', exitCode: 0 }); parameters.onToolResult({ id: 'duplicate', type: 'commandExecution', status: 'completed', exitCode: 0 }); resolve('已完成'); }; }));
  try {
    const input = { text: '提供文案', mode: 'auto', requestId: 'stable-request' }; const ids = await Promise.all([f.post(input), f.post(input)]); assert.equal(ids[0], ids[1]); await until(() => finish);
    const epoch = f.app.room.chat().scheduler.epoch; await f.request('/api/control', { action: 'pause', epoch }); assert.equal((await f.request('/api/control', { action: 'resume', epoch })).status, 409);
    finish(); await f.stop(); assert.equal(f.app.room.current.status, 'paused'); assert.equal(f.calls.length, 1); assert.doesNotMatch(JSON.stringify(f.app.room.state), /不应写入/); assert.equal(f.app.room.current.evidence.length, 0);
  } finally { await f.close(); }
});
test('用户缺口补齐后从周期检查点继续，不重复完成动作', async () => {
  let blocked = false; const f = await fixture(async ({ task, author }) => {
    if (!blocked && author === 'codex') { blocked = true; return record(task, { deliverables: [{ name: '稿', text: '已经完成且应保留的稿件。' }], blockers: [{ id: 'input', type: 'user', description: '请确认正文采用中文还是英文。' }] }); }
    return record(task, author === 'deepseek' ? finalReview(task) : {});
  });
  try { await f.post({ target: 'codex_deepseek' }); let task = await f.stop(); assert.equal(task.stopReason, 'waiting_user'); assert.equal((await f.request('/api/control', { action: 'resume' })).status, 400); assert.equal((await f.request('/api/blockers', { chatId: task.chatId, answers: { input: '中文' } })).status, 200); await f.request('/api/control', { action: 'resume' }); task = await f.stop(); assert.equal(task.status, 'completed'); assert.deepEqual(f.calls.map(item => item.author), ['codex', 'deepseek']); assert.equal(f.app.room.chat().scheduler.sessionRounds, 1); } finally { await f.close(); }
});
test('需求变更重开验收，旧证据不能通过，暂停及累计预算保留', async () => {
  const f = await fixture(async ({ task, author }) => record(task, author === 'deepseek' && task.evidence.length ? finalReview(task) : { deliverables: [{ name: '稿件', text: '原要求的实际成稿。' }] }));
  try { await f.post({ target: 'codex_deepseek' }); let task = await f.stop(); assert.equal(task.status, 'completed'); const count = f.app.room.chat().scheduler.sessionRounds;
    await f.request('/api/budget', { chatId: task.chatId, budget: { sessionRounds: count } }); await f.post({ text: '改成另一种语言并保留原格式', target: 'codex_deepseek' }); task = await f.stop(); assert.equal(task.taskRevision, 2); assert.equal(task.status, 'paused'); assert.equal(task.acceptance[0].status, 'open'); assert.equal(f.app.room.chat().scheduler.sessionRounds, count);
    await f.post({ text: '再增加一段结尾' }); assert.equal(task.status, 'paused'); assert.equal(task.taskRevision, 3); assert.equal(f.app.room.chat().scheduler.sessionRounds, count); assert.equal((await f.request('/api/control', { action: 'resume' })).status, 409); assert.match(task.acceptance[0].description, /另一种语言/);
  } finally { await f.close(); }
});
test('进展生成失败明确报错，不伪造记录或完成状态', async () => {
  const f = await fixture(async () => '已完成\n```room-progress\n{bad json}\n```');
  try { await f.post(); const task = await f.stop(); assert.equal(task.stopReason, 'execution_error'); assert.match(task.pauseReason, /JSON/); assert.equal(task.rounds[0].complete, false); assert.equal(task.evidence.length, 0); } finally { await f.close(); }
});
test('历史配置迁移计时不可靠时暂停，不默认累计归零', async () => {
  const f = await fixture(async ({ task }) => record(task));
  try { await f.app.close(); const store = new RoomStore(f.directory); await store.save({ version: 1, messages: [], tasks: [{ id: 'legacy', title: '旧任务', status: 'running', steps: [{ round: 1, status: 'complete' }] }], currentTaskId: 'legacy' }); await f.restart(); assert.equal(f.app.room.chat().scheduler.recoveryNeeded, true); assert.equal(f.app.room.chat().scheduler.sessionActiveMs, null); await f.post(); assert.equal(f.app.room.current.status, 'paused'); assert.equal(f.calls.length, 0); } finally { await f.close(); }
});
test('同一数据目录只允许一个调度服务，避免两个进程重复预留预算', async () => {
  const f = await fixture(async ({ task }) => record(task));
  try { const second = new RoomStore(f.directory); await assert.rejects(second.load(), /已有调度服务/); } finally { await f.close(); }
});
test('真实 Node 工具检查成功及失败结果均参与验收，失败不能当通过', async () => {
  for (const valid of [false, true]) {
    const f = await fixture(async ({ task, author, parameters }) => {
      if (author === 'codex') { await writeFile(path.join(parameters.workspace, 'result.mjs'), valid ? 'export const result = true;' : 'export const = ;'); return record(task, { checkRequests: [{ acceptanceId: 'accept-1', check: { type: 'node', args: ['--check', 'result.mjs'] } }] }); }
      return record(task, finalReview(task));
    }, { tools: { execute: executeCheck } });
    try { await f.post({ text: '实现代码并验证', target: 'codex_deepseek' }); const task = await f.stop(); assert.equal(task.status, valid ? 'completed' : 'paused'); assert.equal(task.evidence.find(item => item.kind === 'check').passed, valid); } finally { await f.close(); }
  }
});
test('环境阻塞继续前真实复查，恢复后不重复已完成成员动作', async () => {
  let healthy = false; let requested = false; const f = await fixture(async ({ task, author }) => {
    if (!requested && author === 'codex') { requested = true; return record(task, { deliverables: [{ name: '稿', text: '完整交付正文：待环境恢复后由另一位成员审阅。' }], blockers: [{ id: 'environment', type: 'environment', description: '所需环境尚未恢复', check: { type: 'file_contains', path: 'ready.txt', includes: 'ready' } }] }); }
    return record(task, author === 'deepseek' ? { ...finalReview(task), attempts: [{ issueId: 'environment', strategy: '重新验证已恢复环境', evidenceRefs: task.evidence.map(item => item.id), resolved: true }] } : {});
  }, { tools: { execute: async () => ({ passed: healthy, detail: '环境实际探测' }) } });
  try { await f.post({ target: 'codex_deepseek' }); await f.stop(); assert.equal((await f.request('/api/control', { action: 'resume' })).status, 400); healthy = true; assert.equal((await f.request('/api/control', { action: 'resume' })).status, 200); await f.stop(); assert.deepEqual(f.calls.slice(0, 2).map(item => item.author), ['codex', 'deepseek']); assert.equal(f.calls.filter(item => item.author === 'codex').length, 1); } finally { await f.close(); }
});
test('不确定的 Codex 动作禁止盲目重试，显式核对后可以跳过且不重复副作用', async () => {
  let finish; const f = await fixture(async ({ task, author, parameters }) => {
    if (author === 'codex') { await writeFile(path.join(parameters.workspace, 'side-effect.txt'), '操作已发生'); return new Promise(resolve => { finish = () => resolve(record(task)); }); }
    return record(task);
  });
  try { await f.post({ target: 'codex_deepseek' }); await until(() => finish); await f.request('/api/control', { action: 'pause' }); finish(); await f.stop(); let task = f.app.room.current;
    assert.equal((await f.request('/api/control', { action: 'resume' })).status, 409); const action = Object.values(f.app.room.chat().scheduler.actions).find(item => item.status === 'uncertain');
    await f.request('/api/blockers', { chatId: task.chatId, actionKey: action.key, resolution: 'skip', basis: '已读取实际文件并确认操作已经发生，无需重复执行。' });
    await f.request('/api/budget', { chatId: task.chatId, budget: { runRounds: 1 } }); await f.request('/api/control', { action: 'resume' }); await f.stop(); assert.equal(f.calls.filter(item => item.author === 'codex').length, 1); assert.equal(await readFile(path.join(f.app.room.workspaceFor(task.chatId), 'side-effect.txt'), 'utf8'), '操作已发生');
  } finally { await f.close(); }
});
test('单个事项停滞时可继续独立事项，策略文字变化不能重置全局停滞', async () => {
  const f = await fixture(async ({ task, author }) => record(task, {
    issues: [{ id: 'blocked-work', description: '必需事项甲', required: true }, { id: 'independent', description: '独立事项乙', required: false }],
    attempts: [{ issueId: 'blocked-work', strategy: '文字策略 ' + task.checkpoint.number + author, evidenceRefs: [] }],
    ...(task.checkpoint.number <= 3 && author === 'codex' ? { deliverables: [{ name: '独立成稿', text: '独立成果实际更新至 ' + task.checkpoint.number }] } : {})
  }));
  try { await f.post(); const task = await f.stop(); assert.equal(task.stopReason, 'no_progress'); assert.equal(task.run.rounds, 5); assert.equal(task.issues.find(item => item.id === 'blocked-work').status, 'stalled'); assert.equal(task.noProgressRounds, 2); } finally { await f.close(); }
});
test('检查证据对应旧文件内容时不能验收新文件版本', async () => {
  const f = await fixture(async ({ task, author, parameters }) => {
    if (author === 'codex') { await writeFile(path.join(parameters.workspace, 'result.mjs'), 'export const version = 1;'); return record(task, { checkRequests: [{ acceptanceId: 'accept-1', check: { type: 'node', args: ['--check', 'result.mjs'] } }] }); }
    await writeFile(path.join(parameters.workspace, 'result.mjs'), 'export const version = 2;'); return record(task, finalReview(task));
  });
  try { await f.post({ text: '实现代码并验证', target: 'codex_deepseek', budget: { runRounds: 3 } }); const task = await f.stop(); assert.equal(task.status, 'paused'); assert.equal(task.acceptance[0].status, 'open'); } finally { await f.close(); }
});
test('计时恢复遇到调度端时钟倒退时暂停并要求人工恢复，不归零', async () => {
  const f = await fixture(async ({ task }) => record(task));
  try { await f.app.close(); const state = JSON.parse(await readFile(path.join(f.directory, 'room.json'))); state.chats[0].scheduler.sessionActiveMs = 12345; state.chats[0].scheduler.clock = { running: true, wall: Date.now() + 100000 }; await writeFile(path.join(f.directory, 'room.json'), JSON.stringify(state)); await f.restart(); assert.equal(f.app.room.chat().scheduler.recoveryNeeded, true); assert.equal(f.app.room.chat().scheduler.sessionActiveMs, 12345); } finally { await f.close(); }
});
test('原生 Codex 必要输入请求自动暂停，等待时间不计入活动预算', async () => {
  const f = await fixture(async ({ app, parameters }) => new Promise(resolve => { app.room.requestApproval({ rpcId: 8, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'language', question: '请选择语言' }] } }); parameters.signal.addEventListener('abort', () => resolve('被暂停的回复'), { once: true }); }));
  try { await f.post({ target: 'codex_deepseek' }); await f.stop(); assert.equal(f.app.room.current.stopReason, 'waiting_user'); assert.equal(f.app.room.current.issues[0].status, 'blocked'); const activeMs = f.app.room.chat().scheduler.sessionActiveMs; await delay(30); assert.equal(f.app.room.chat().scheduler.sessionActiveMs, activeMs); } finally { await f.close(); }
});
test('写网页方案属于成稿交付，不强制修改代码', async () => {
  const f = await fixture(async ({ task, author }) => record(task, author === 'codex' ? { deliverables: [{ name: '网页方案', text: '完整网页规划方案，包含布局、交互流程和验收标准。' }] } : finalReview(task)));
  try { await f.post({ text: '请写一份网页设计方案', target: 'codex_deepseek' }); const task = await f.stop(); assert.equal(task.status, 'completed'); assert.equal(task.acceptance[0].type, 'subjective'); assert.equal(f.tools.length, 0); } finally { await f.close(); }
});
test('真实子进程强制退出后恢复预算、代次和不确定动作，不自动续跑', async () => {
  const f = await fixture(async ({ task }) => record(task)); let child;
  try {
    await f.app.close(); let output = '';
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/crash-worker.mjs', import.meta.url)), f.directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', value => output += value);
    await until(() => output.includes('url')); const url = JSON.parse(output.split('\n')[0]).url; const cookie = (await fetch(url)).headers.get('set-cookie').split(';')[0];
    const response = await fetch(url + '/api/messages', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Room-Request': '1' }, body: JSON.stringify({ text: '成稿任务', mode: 'auto', target: 'codex_deepseek' }) }); assert.equal(response.status, 202);
    await until(() => output.includes('CALL_STARTED')); const before = JSON.parse(await readFile(path.join(f.directory, 'room.json'))); await delay(30);
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; await f.restart();
    const task = f.app.room.current; const session = f.app.room.chat().scheduler;
    assert.equal(task.status, 'paused'); assert.equal(session.sessionRounds, 1); assert.ok(session.sessionActiveMs >= before.chats[0].scheduler.sessionActiveMs); assert.ok(session.epoch > before.chats[0].scheduler.epoch); assert.ok(Object.values(session.actions).some(item => item.status === 'uncertain')); assert.equal(f.calls.length, 0); assert.equal((await f.request('/api/control', { action: 'resume' })).status, 409);
  } finally { child?.kill(); await f.close(); }
});
test('同代次完成后的迟到回调不修改旧消息，重复完成事件只记录一次', async () => {
  let previous; const f = await fixture(async ({ task, parameters, calls }) => {
    if (calls.length === 1) { previous = parameters; const result = { id: 'tool-1', type: 'commandExecution', status: 'completed', command: '读取实际文件', exitCode: 0, aggregatedOutput: '实际工具返回' }; parameters.onToolResult(result); parameters.onToolResult(result); }
    else { previous.onDelta('完成后不得追加的迟到内容'); previous.onToolResult({ id: 'late', type: 'commandExecution', status: 'completed', exitCode: 0 }); }
    return record(task);
  });
  try { await f.post(); const task = await f.stop(); assert.doesNotMatch(JSON.stringify(f.app.room.state), /完成后不得追加/); assert.equal(task.evidence.filter(item => item.kind === 'tool_result').length, 1); } finally { await f.close(); }
});
test('一次操作授权不能用于不同文件范围的新权限请求', async () => {
  const f = await fixture(async ({ app, parameters, calls }) => new Promise(resolve => {
    app.room.requestApproval({ rpcId: calls.length, method: 'item/fileChange/requestApproval', params: { grantRoot: calls.length === 1 ? 'first-directory' : 'other-directory', reason: '修改任务文件' } });
    parameters.signal.addEventListener('abort', () => resolve('当前操作已暂停'), { once: true });
  }));
  try {
    await f.post({ target: 'codex_deepseek' }); await f.stop(); const task = f.app.room.current; const issue = task.issues[0];
    await f.request('/api/blockers', { chatId: task.chatId, answers: { [issue.id]: '允许本次操作' } });
    const action = Object.values(f.app.room.chat().scheduler.actions).find(item => item.status === 'uncertain');
    await f.request('/api/blockers', { chatId: task.chatId, actionKey: action.key, resolution: 'retry', basis: '已核对尚未写入任何文件，仅允许重试原目录操作。' });
    await f.request('/api/control', { action: 'resume' }); await f.stop(); assert.equal(task.status, 'paused'); assert.equal(task.stopReason, 'permission'); assert.equal(task.issues.filter(item => item.status === 'blocked').length, 1); assert.notEqual(task.issues.at(-1).requestFingerprint, issue.requestFingerprint);
  } finally { await f.close(); }
});
test('工作目录内 data 成果也进入文件证据快照', async () => {
  const f = await fixture(async ({ task }) => record(task));
  try { const workspace = f.app.room.workspaceFor(f.app.room.chat().id); await mkdir(path.join(workspace, 'data'), { recursive: true }); await writeFile(path.join(workspace, 'data', 'result.json'), '{"actual":true}'); const snapshot = await filesSnapshot(workspace); assert.ok(snapshot[path.join('data', 'result.json')]); } finally { await f.close(); }
});
