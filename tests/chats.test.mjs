import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Room } from '../src/room.mjs';
import { Configuration, AppError } from '../src/config.mjs';
import { migrateChats } from '../src/chats.mjs';
import { RoomStore } from '../src/store.mjs';
import { CodexClient } from '../src/codex.mjs';
import { createApp } from '../server.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const deadline = Date.now() + 3000; while (Date.now() < deadline) { if (predicate()) return; await delay(10); } throw new Error('Timed out'); }
function setup(run) {
  const configuration = new Configuration(path.join(os.tmpdir(), 'chat-tests'), { codexPath: 'C:/codex.exe', deepseekKey: 'hidden-test-key' }); configuration.resetStatus();
  const store = { load: async () => ({ version: 1, messages: [], tasks: [], currentTaskId: null }), save: async () => {} };
  const responses = []; const providers = { run, close() {}, codex: { respond: (...args) => responses.push(args) } };
  return { room: new Room(store, configuration, providers), configuration, providers, store, responses };
}

test('legacy records become separate chats without losing IDs, texts, or current task', () => {
  const old = { version: 1, tasks: [{ id: 'one', title: '任务一', status: 'complete' }, { id: 'two', title: '任务二', status: 'paused' }], messages: [{ id: 'm1', taskId: 'one', text: '历史一' }, { id: 'm2', taskId: 'two', text: '历史二' }, { id: 'm3', taskId: null, text: '早期消息' }], currentTaskId: 'two' };
  const result = migrateChats(old); assert.equal(result.version, 2); assert.equal(result.chats.length, 3);
  assert.notEqual(result.messages[0].chatId, result.messages[1].chatId); assert.equal(result.currentChatId, result.tasks[1].chatId);
  assert.deepEqual(result.messages.map(message => [message.id, message.text]), [['m1', '历史一'], ['m2', '历史二'], ['m3', '早期消息']]); assert.ok(result.chats.every(chat => !chat.isolatedWorkspace));
  assert.equal(migrateChats(result), result);
});

test('new chats isolate both models from other chats and have independent workspaces', async () => {
  const calls = []; const { room } = setup(async (id, prompt, options) => { calls.push({ id, prompt, ...options }); return `完成 ${id}`; });
  const a = room.chat(); await room.post({ text: 'Alpha 专属内容', chatId: a.id, target: 'codex_deepseek' }); await until(() => room.taskFor(a.id).status === 'paused');
  const b = await room.createChat(); await room.post({ text: 'Beta 专属内容', chatId: b.id, target: 'codex_deepseek' }); await until(() => room.taskFor(b.id).status === 'paused');
  assert.equal(room.chat(a.id).title, 'Alpha 专属内容'); assert.equal(room.chat(b.id).title, 'Beta 专属内容');
  for (const call of calls.filter(call => call.chatId === b.id)) { assert.doesNotMatch(call.prompt, /Alpha/); assert.match(call.prompt, /Beta/); }
  assert.notEqual(room.workspaceFor(a.id), room.workspaceFor(b.id));
  await room.post({ text: 'Alpha 继续处理', chatId: a.id, target: 'codex' }); await room.control('resume', a.id); await until(() => room.taskFor(a.id).status === 'paused');
  assert.match(calls.at(-1).prompt, /Alpha 专属内容/); assert.doesNotMatch(calls.at(-1).prompt, /Beta/);
  assert.equal(room.state.messages.filter(message => message.author === 'user' && message.chatId === b.id).length, 1); await room.close();
});

test('creating and posting to another chat queues its task without interrupting the running chat', async () => {
  let finish; let firstSignal; const calls = [];
  const { room } = setup(async (id, prompt, options) => { calls.push(options.chatId); if (calls.length === 1) { firstSignal = options.signal; return new Promise(resolve => finish = resolve); } return '后续完成'; });
  const a = room.chat(); await room.post({ text: '运行 A', chatId: a.id, target: 'deepseek' }); await until(() => finish);
  const b = await room.createChat(); await room.post({ text: '排队 B', chatId: b.id, target: 'deepseek' });
  assert.equal(firstSignal.aborted, false); assert.equal(room.taskFor(a.id).status, 'running'); assert.equal(room.taskFor(b.id).status, 'queued');
  await room.post({ text: 'B 增加要求', chatId: b.id, target: 'deepseek' }); assert.equal(firstSignal.aborted, false);
  finish('A 完成'); await until(() => room.taskFor(a.id).status === 'paused' && room.taskFor(b.id).status === 'paused'); assert.deepEqual(calls, [a.id, b.id]); await room.close();
});

test('controls and approvals belong to their chat, and pausing a queued task leaves another running', async () => {
  let finish; const { room, responses } = setup(async (id, prompt, options) => new Promise((resolve, reject) => { finish = resolve; options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }));
  const a = room.chat(); await room.post({ text: 'A', chatId: a.id, target: 'codex' }); await until(() => finish);
  room.requestApproval({ rpcId: 4, method: 'item/fileChange/requestApproval', params: {} }); const approval = room.approvals[0]; assert.equal(approval.chatId, a.id);
  const b = await room.createChat(); await room.post({ text: 'B', chatId: b.id, target: 'deepseek' }); await room.control('pause', b.id);
  assert.equal(room.taskFor(a.id).status, 'running'); assert.equal(room.approvals.length, 1);
  await room.answerApproval(approval.id, 'decline'); assert.equal(room.state.messages.at(-1).chatId, a.id); assert.equal(responses[0][0], 4);
  finish('A 完成'); await until(() => !room.running); assert.equal(room.taskFor(b.id).status, 'paused');
  await assert.rejects(room.post({ text: '错误目标', chatId: '../other-chat' }), AppError); await room.close();
});

test('version-two chats and their task links survive save and reload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-room-chats-'));
  try {
    const { configuration, providers } = setup(async () => '完成'); const store = new RoomStore(directory); const room = new Room(store, configuration, providers); await room.load();
    const a = room.chat(); await room.post({ text: '可恢复任务', chatId: a.id, target: 'deepseek' }); await until(() => room.taskFor(a.id).status === 'paused'); const b = await room.createChat(); await room.close();
    const restored = new Room(store, configuration, providers); await restored.load(); assert.equal(restored.state.version, 3); assert.equal(restored.chat(a.id).title, '可恢复任务'); assert.equal(restored.chat(b.id).currentTaskId, null); assert.equal(restored.taskFor(a.id).status, 'paused'); await restored.close();
  } finally { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^agent-room-chats-/); await rm(directory, { recursive: true, force: true }); }
});

test('Codex reuses a thread within one chat and starts another thread for another chat', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-room-chats-')); const client = new CodexClient({ value: { workspace: directory } });
  const threads = []; const starts = []; let sequence = 0;
  client.connect = async () => {};
  client.request = async (method, params) => {
    if (method === 'thread/start') { starts.push(params); return { thread: { id: 'thread-' + (starts.length) } }; }
    if (method === 'turn/start') { threads.push(params.threadId); const turnId = 'turn-' + (++sequence); queueMicrotask(() => { client.receive({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, itemId: 'item', delta: '完成' } }); client.receive({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } }); }); return { turn: { id: turnId } }; }
    throw new Error('Unexpected method');
  };
  try {
    for (const chatId of ['A', 'B', 'A']) assert.equal(await client.run('本聊天任务', { chatId, signal: new AbortController().signal, onDelta() {}, onActivity() {} }), '完成');
    assert.equal(starts.length, 2); assert.deepEqual(threads, ['thread-1', 'thread-2', 'thread-1']);
  } finally { client.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^agent-room-chats-/); await rm(directory, { recursive: true, force: true }); }
});

test('chat creation requires authentication and is visible on two event connections', async () => {
  const { configuration, providers, store } = setup(async () => '完成'); const app = await createApp({ configuration, providers, store, port: 0 }); const url = await app.listen(); const controller = new AbortController();
  try {
    const home = await fetch(url); const headers = { Cookie: home.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-Room-Request': '1' };
    assert.equal((await fetch(url + '/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const readers = []; for (let i = 0; i < 2; i++) { const response = await fetch(url + '/api/events', { headers, signal: controller.signal }); const reader = response.body.getReader(); await reader.read(); readers.push(reader); }
    const response = await fetch(url + '/api/chats', { method: 'POST', headers, body: '{}' }); assert.equal(response.status, 201); const { chat } = await response.json();
    for (const reader of readers) assert.match(new TextDecoder().decode((await reader.read()).value), new RegExp(chat.id));
    assert.equal(app.room.state.messages.length, 0); assert.equal(app.room.state.tasks.length, 0); assert.equal(app.room.chat(chat.id).title, '新聊天');
  } finally { controller.abort(); await app.close(); }
});

test('late Codex approval requests are declined instead of appearing in a different chat', () => {
  const requests = []; const responses = []; const client = new CodexClient({ value: {} }, request => requests.push(request)); client.respond = (...args) => responses.push(args);
  client.threadId = 'current-thread'; client.active = { signal: new AbortController().signal };
  client.receive({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'old-thread' } });
  assert.equal(requests.length, 0); assert.deepEqual(responses[0], [1, { decision: 'decline' }]);
  client.active = null; client.receive({ id: 2, method: 'item/tool/requestUserInput', params: {} }); assert.equal(responses[1][2].code, -32000);
});
