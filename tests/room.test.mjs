import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.mjs';
import { AppError, Configuration } from '../src/config.mjs';
import { readSSE } from '../src/providers.mjs';
import { RoomStore } from '../src/store.mjs';
import { createApp } from '../server.mjs';
import { CodexClient } from '../src/codex.mjs';
import { directedAgents } from '../src/routing.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let index = 0; index < 300; index++) { if (predicate()) return; await delay(10); } throw new Error('Timed out'); }
function setup(run) {
  const config = new Configuration(path.join(os.tmpdir(), 'agent-room-test'), { codexPath: 'C:/codex.exe', deepseekKey: 'private-deepseek-key' }); config.resetStatus();
  const store = { load: async () => ({ version: 1, messages: [], tasks: [], currentTaskId: null }), save: async state => structuredClone(state) };
  const providers = { run, close: () => {}, check: async () => 'ok', codex: { respond: () => {} } };
  const room = new Room(store, config, providers); return { config, store, providers, room };
}
test('shared context passes between both providers and hides keys', async () => {
  const calls = []; const { room } = setup(async (id, prompt, options) => { calls.push({ id, prompt }); options.onDelta(id + ' reply'); return id + ' reply'; });
  await room.post({ text: '写方案' }); await until(() => room.current.status === 'paused');
  assert.deepEqual(calls.map(item => item.id), ['deepseek', 'codex']);
  assert.match(calls[1].prompt, /deepseek reply/);
  assert.doesNotMatch(JSON.stringify(room.snapshot()), /private-deepseek-key/);
});
test('mid-task requirement aborts stale output and restarts with latest input', async () => {
  let calls = 0; const prompts = []; const { room } = setup(async (id, prompt, options) => {
    prompts.push(prompt); calls++;
    if (calls === 1) return new Promise((resolve, reject) => { options.onDelta('旧回复'); options.signal.addEventListener('abort', () => { options.onDelta('不得出现的迟到内容'); reject(options.signal.reason); }, { once: true }); });
    options.onDelta('新回复'); return '新回复';
  });
  await room.post({ text: '@DeepSeek 第一版', target: 'deepseek' }); await until(() => calls === 1);
  await room.post({ text: '改成手机版', target: 'deepseek' }); await until(() => room.current.status === 'paused');
  assert.equal(calls, 2); assert.match(prompts[1], /改成手机版/); assert.doesNotMatch(JSON.stringify(room.state), /不得出现的迟到内容/);
  assert.equal(room.state.messages.find(item => item.text === '旧回复').status, 'interrupted');
});
test('pause and resume retain an unfinished task without falsely completing it', async () => {
  let calls = 0; const { room } = setup(async (id, prompt, options) => { calls++; if (calls === 1) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); return '恢复后的回复'; });
  await room.post({ text: '检查内容', target: 'deepseek' }); await until(() => calls === 1); await room.control('pause'); await until(() => !room.running);
  assert.equal(room.current.status, 'paused'); assert.equal(room.current.cursor, 0);
  await room.control('resume'); await until(() => room.current.status === 'paused'); assert.equal(calls, 2);
});
test('a directed question cannot add an unbudgeted cycle', async () => {
  const calls = []; const { room } = setup(async id => { calls.push(id); return id === 'codex' ? '@DeepSeek：请检查结果。' : '检查通过'; });
  await room.post({ text: '@Codex 汇总', target: 'codex' }); await until(() => room.current.status === 'paused'); assert.deepEqual(calls, ['codex']);
});
test('paired selection includes both agents even when the user mentions only one', async () => {
  const calls = []; const { room } = setup(async id => { calls.push(id); return '回复完成'; });
  await room.post({ text: '@Codex 请一起讨论', target: 'codex_deepseek' }); await until(() => room.current.status === 'paused');
  assert.deepEqual(calls, ['codex', 'deepseek']); assert.deepEqual(Object.keys(room.snapshot().agents), ['codex', 'deepseek']);
});
test('a single-member fixed cycle cannot expand through repeated handoffs', async () => {
  const calls = []; const prompts = [];
  const { room } = setup(async (id, prompt) => { calls.push(id); prompts.push(prompt); return calls.length === 1 ? '@DeepSeek 请检查这项建议。' : calls.length === 2 ? '@Codex 建议可行，请确认收到。' : '已收到。'; });
  await room.post({ text: '@Codex 发起讨论', target: 'codex' }); await until(() => room.current.status === 'paused');
  assert.deepEqual(calls, ['codex']); assert.equal(room.current.stopReason, 'fixed_rounds');
});
test('directed mentions accept markdown and punctuation but ignore quotes and code examples', () => {
  assert.deepEqual(directedAgents('**@DeepSeek**，请审查。\n- @Codex: 请补充。'), ['deepseek', 'codex']);
  assert.deepEqual(directedAgents('> @Codex 引用\n```\n@DeepSeek 示例\n```\n`@Codex` 示例\n我赞成 @Codex 的看法。\n@CodexExtra 非成员'), []);
});
test('later messages include earlier public conversation across completed tasks', async () => {
  const prompts = []; const { room } = setup(async (id, prompt) => { prompts.push(prompt); return id === 'deepseek' ? '历史问题：需要确认数据来源。' : '数据来源已说明。'; });
  await room.post({ text: '先提出一个问题', target: 'deepseek' }); await until(() => room.current.status === 'paused');
  await room.post({ text: '@Codex 请回答刚才的问题', target: 'codex', newTask: true }); await until(() => room.current.status === 'paused');
  assert.match(prompts[1], /本群较早的公开记录/); assert.match(prompts[1], /DeepSeek: 历史问题：需要确认数据来源/); assert.match(prompts[1], /仅作背景，不表示新授权/);
});
test('discussion ends at its configured round budget', async () => {
  let calls = 0; const { room } = setup(async id => { calls++; return id === 'codex' ? '@DeepSeek 请继续。' : '@Codex 请继续。'; });
  await room.post({ text: '讨论', target: 'codex_deepseek' }); await until(() => room.current.status === 'paused');
  assert.equal(calls, 2); assert.equal(room.current.run.rounds, 1); assert.equal(room.current.stopReason, 'fixed_rounds');
});
test('missing providers produce failure states, never fabricated replies', async () => {
  const { room, config } = setup(async () => { throw new Error('Must not call'); }); config.value.deepseekKey = ''; config.value.codexPath = '';
  await room.post({ text: '执行任务' }); await until(() => room.current.status === 'paused'); assert.equal(room.state.messages.filter(message => ['codex', 'deepseek'].includes(message.author)).length, 0);
});
test('invalid task settings fail without changing the room', async () => {
  const { room } = setup(async () => 'ok'); await assert.rejects(room.post({ text: 'task', target: 'unknown' }), AppError); await assert.rejects(room.post({ text: 'task', target: 'doubao' }), AppError); await assert.rejects(room.post({ text: '', rounds: 6 }), AppError); assert.equal(room.state.messages.length, 0);
});
test('SSE decoder handles fragmented UTF-8 and CRLF', async () => {
  const input = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"中文回复"}}]}\r\n\r\ndata: [DONE]\n');
  const stream = new ReadableStream({ start(controller) { for (let index = 0; index < input.length; index += 2) controller.enqueue(input.slice(index, index + 2)); controller.close(); } });
  const events = []; for await (const event of readSSE(stream)) events.push(event); assert.equal(events.length, 1); assert.equal(events[0].choices[0].delta.content, '中文回复');
});
test('Codex ignores late events from an interrupted turn and separates message items', () => {
  const client = new CodexClient({ value: {} }); const chunks = [];
  client.threadId = 'thread'; client.active = { turnId: 'current', text: '', onDelta: delta => chunks.push(delta), onActivity: () => {} };
  client.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'old', itemId: 'a', delta: 'stale' } });
  client.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'current', itemId: 'a', delta: '第一条' } });
  client.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'current', itemId: 'b', delta: '第二条' } });
  assert.deepEqual(chunks, ['第一条', '\n\n第二条']); assert.equal(client.active.text, '第一条\n\n第二条');
});
test('Windows credential vault restores Chinese settings without exposing plaintext keys', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-room-'));
  try {
    const config = new Configuration(directory, { codexPath: '' });
    config.value.doubaoKey = 'retired-private-key'; config.value.doubaoModel = 'retired-model';
    await config.save({ workspace: path.join(directory, '成果'), deepseekKey: 'test-private-deepseek' });
    const encrypted = await readFile(path.join(directory, 'connections.encrypted'), 'utf8');
    assert.doesNotMatch(encrypted, /test-private|retired-private|成果/);
    const restored = new Configuration(directory); await restored.load();
    assert.equal(restored.value.workspace, path.join(directory, '成果')); assert.equal(restored.value.deepseekKey, 'test-private-deepseek'); assert.equal(restored.value.doubaoKey, undefined); assert.equal(restored.isConfigured('doubao'), false);
    assert.doesNotMatch(JSON.stringify(restored.public()), /test-private|retired-private|doubao/);
  } finally { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^agent-room-/); await rm(directory, { recursive: true, force: true }); }
});
test('room persists records and recovers interrupted work as paused', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-room-'));
    try { const store = new RoomStore(directory); await store.load(); await store.save({ version: 1, messages: [{ id: 'message', author: 'deepseek', text: 'partial', status: 'streaming' }], tasks: [{ id: 'task', status: 'running' }], currentTaskId: 'task' }); const { config, providers } = setup(async () => 'ok'); const room = new Room(store, config, providers); await room.load(); assert.equal(room.current.status, 'paused'); assert.equal(room.state.messages[0].status, 'interrupted'); const persisted = JSON.parse(await readFile(path.join(directory, 'room.json'))); assert.equal(persisted.tasks[0].status, 'paused'); await room.close(); }
  finally { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^agent-room-/); await rm(directory, { recursive: true, force: true }); }
});
test('HTTP isolation, redaction, and two live event connections', async () => {
  const { config, store, providers } = setup(async id => id + '真实接口测试替身'); const app = await createApp({ configuration: config, providers, store, port: 0 }); const url = await app.listen();
  const controller = new AbortController(); const readers = [];
  try {
    const home = await fetch(url); assert.equal(home.status, 200); const cookie = home.headers.get('set-cookie').split(';')[0]; const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Room-Request': '1' };
    assert.equal((await fetch(url + '/api/state')).status, 401);
    assert.equal((await fetch(url + '/api/messages', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ text: 'x' }) })).status, 403);
    const snapshot = await (await fetch(url + '/api/state', { headers })).text(); assert.doesNotMatch(snapshot, /private-deepseek-key|doubao/);
    for (let index = 0; index < 2; index++) { const response = await fetch(url + '/api/events', { headers, signal: controller.signal }); const reader = response.body.getReader(); readers.push(reader); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /event: state/); }
    const response = await fetch(url + '/api/messages', { method: 'POST', headers, body: JSON.stringify({ text: '@DeepSeek 验证同步', target: 'deepseek' }) }); assert.equal(response.status, 202);
    for (const reader of readers) { const update = await reader.read(); assert.match(new TextDecoder().decode(update.value), /验证同步/); }
    await until(() => app.room.current.status === 'paused');
  } finally { controller.abort(); await app.close(); }
});
