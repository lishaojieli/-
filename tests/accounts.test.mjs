import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AccountMonitor, codexUsage, deepseekBalance } from '../src/accounts.mjs';
import { Configuration, AppError } from '../src/config.mjs';
import { CodexClient } from '../src/codex.mjs';
import { Providers } from '../src/providers.mjs';
import { createApp } from '../server.mjs';

const quota = (used = 44, weekly = 15) => ({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1791535985 }, secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: 1791951631 } } } });
const balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5.83', granted_balance: '5.83', topped_up_balance: '0.00' }] };
function config() { const value = new Configuration('C:/temporary-accounts', { codexPath: 'C:/codex.exe', deepseekKey: 'test-secret' }); value.resetStatus(); return value; }

test('Codex selects the main bucket, matches durations, and treats missing fields as unavailable', () => {
  const payload = quota(); payload.rateLimits = { primary: { usedPercent: 99, windowDurationMins: 300 } };
  let result = codexUsage(payload);
  assert.equal(result.fiveHour.remainingPercent, 56); assert.equal(result.weekly.remainingPercent, 85);
  payload.rateLimitsByLimitId.codex.primary = { usedPercent: null, windowDurationMins: 10080, resetsAt: null };
  payload.rateLimitsByLimitId.codex.secondary = { usedPercent: 130, windowDurationMins: 300 };
  result = codexUsage(payload); assert.equal(result.fiveHour.remainingPercent, 0); assert.equal(result.weekly.remainingPercent, null); assert.equal(result.weekly.resetsAt, null);
  assert.equal(codexUsage(quota(-5)).fiveHour.remainingPercent, 100);
  assert.equal(codexUsage({ rateLimits: { primary: { usedPercent: 4, windowDurationMins: 60 } } }).fiveHour, null);
  assert.equal(codexUsage({ rateLimits: { limitId: 'code_review' } }, result, true), null);
  assert.throws(() => codexUsage({ rateLimits: null }), AppError);
});

test('partial Codex pushes preserve the other window, while full reads can clear unavailable data', () => {
  const original = codexUsage(quota());
  const partial = { rateLimits: { limitId: 'codex', primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1791535985 } } };
  assert.equal(codexUsage(partial, original, true).weekly.remainingPercent, 85);
  assert.equal(codexUsage(partial, original, true).fiveHour.remainingPercent, 40);
  assert.equal(codexUsage(partial).weekly, null);
});

test('DeepSeek preserves exact decimals and separate currencies, including zero balances', () => {
  const payload = structuredClone(balance); payload.balance_infos.push({ currency: 'USD', total_balance: '0.000001', granted_balance: null, topped_up_balance: '0.000001' });
  const result = deepseekBalance(payload); assert.equal(result.balances[1].total, '0.000001'); assert.equal(result.balances[1].granted, null);
  assert.equal(deepseekBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }).balances[0].total, '0.00');
  assert.throws(() => deepseekBalance({ is_available: true, balance_infos: [] }), AppError);
  assert.throws(() => deepseekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'NaN' }] }), AppError);
});

test('monitor coalesces reads and keeps successful data on later network failure', async () => {
  let calls = 0; let release; let fail = false;
  const providers = { accountData: () => { calls++; return fail ? Promise.reject(new Error('test-secret upstream error')) : new Promise(resolve => release = resolve); } };
  const monitor = new AccountMonitor(config(), providers);
  try {
    const a = monitor.refresh('deepseek'); const b = monitor.refresh('deepseek'); assert.equal(a, b);
    await Promise.resolve(); release(balance); await a; assert.equal(calls, 1);
    fail = true; await monitor.refresh('deepseek'); const snapshot = monitor.snapshot();
    assert.equal(snapshot.deepseek.state, 'error'); assert.equal(snapshot.deepseek.data.balances[0].total, '5.83'); assert.ok(snapshot.deepseek.updatedAt);
    assert.doesNotMatch(JSON.stringify(snapshot), /test-secret/);
  } finally { monitor.close(); }
});

test('credential changes discard in-flight data and allow a fresh read', async () => {
  const resolvers = []; const monitor = new AccountMonitor(config(), { accountData: () => new Promise(resolve => resolvers.push(resolve)) });
  try {
    const old = monitor.refresh('deepseek'); await Promise.resolve(); monitor.invalidate();
    const fresh = monitor.refresh('deepseek'); await Promise.resolve(); resolvers[0](balance); await old;
    assert.equal(monitor.snapshot().deepseek.data, null); assert.equal(monitor.snapshot().deepseek.refreshing, true);
    const next = structuredClone(balance); next.balance_infos[0].total_balance = '10.00'; resolvers[1](next); await fresh;
    assert.equal(monitor.snapshot().deepseek.data.balances[0].total, '10.00');
  } finally { monitor.close(); }
});

test('automatic polling refreshes both accounts and stops when the monitor closes', async () => {
  const calls = { codex: 0, deepseek: 0 };
  const monitor = new AccountMonitor(config(), { accountData: async id => { calls[id]++; return id === 'codex' ? quota() : balance; } }, { intervalMs: 20 });
  try {
    monitor.start(); monitor.start();
    const deadline = Date.now() + 2000;
    while ((calls.codex < 2 || calls.deepseek < 2) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(calls.codex >= 2 && calls.deepseek >= 2); monitor.close();
    const finished = { ...calls }; await new Promise(resolve => setTimeout(resolve, 60)); assert.deepEqual(calls, finished);
  } finally { monitor.close(); }
});

test('Codex notifications work outside a turn and cannot be overwritten by an earlier read', async () => {
  const codex = new CodexClient({ value: {} }); let release;
  const monitor = new AccountMonitor(config(), { codex, accountData: () => new Promise(resolve => release = resolve) });
  try {
    const read = monitor.refresh('codex'); await Promise.resolve();
    codex.receive({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: 1791535985 } } } });
    assert.equal(monitor.snapshot().codex.data.fiveHour.remainingPercent, 30);
    release(quota(44, 20)); await read;
    assert.equal(monitor.snapshot().codex.data.fiveHour.remainingPercent, 30); assert.equal(monitor.snapshot().codex.data.weekly.remainingPercent, 80);
    monitor.close(); codex.receive({ method: 'account/rateLimits/updated', params: quota(99) });
    assert.equal(monitor.snapshot().codex.data.fiveHour.remainingPercent, 30);
  } finally { monitor.close(); codex.close(); }
});

test('DeepSeek account query is a read-only official request and does not leak keys in errors', async () => {
  const original = globalThis.fetch; const providers = new Providers(config()); let request;
  try {
    globalThis.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify(balance), { status: 200 }); };
    assert.deepEqual(await providers.accountData('deepseek'), balance);
    assert.equal(request.url, 'https://api.deepseek.com/user/balance'); assert.equal(request.options.method, undefined); assert.equal(request.options.headers.Authorization, 'Bearer test-secret'); assert.equal(request.options.body, undefined);
    globalThis.fetch = async () => new Response('test-secret error body', { status: 401 });
    await assert.rejects(providers.accountData('deepseek'), error => /密钥无效/.test(error.message) && !error.message.includes('test-secret'));
  } finally { globalThis.fetch = original; providers.close(); }
});

test('manual account refresh is authenticated and synchronizes two event connections', async () => {
  const providers = { codex: new EventEmitter(), close() {}, accountData: async id => id === 'codex' ? quota() : balance };
  const store = { load: async () => ({ version: 1, tasks: [], messages: [], currentTaskId: null }), save: async () => {} };
  const app = await createApp({ configuration: config(), providers, store, port: 0 }); const url = await app.listen();
  const controller = new AbortController(); const readers = [];
  try {
    const home = await fetch(url); const cookie = home.headers.get('set-cookie').split(';')[0]; const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Room-Request': '1' };
    assert.equal((await fetch(url + '/api/accounts/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    for (let i = 0; i < 2; i++) { const response = await fetch(url + '/api/events', { headers, signal: controller.signal }); const reader = response.body.getReader(); readers.push(reader); await reader.read(); }
    const response = await fetch(url + '/api/accounts/refresh', { method: 'POST', headers, body: '{}' }); const data = await response.json(); assert.equal(data.codex.data.fiveHour.remainingPercent, 56); assert.equal(data.deepseek.data.balances[0].total, '5.83');
    for (const reader of readers) {
      let text = ''; for (let i = 0; i < 10 && !text.includes('"total":"5.83"'); i++) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /"remainingPercent":56/); assert.match(text, /"total":"5.83"/); assert.doesNotMatch(text, /test-secret/);
    }
    const snapshot = await (await fetch(url + '/api/state', { headers })).json(); assert.equal(snapshot.messages.length, 0); assert.equal(snapshot.tasks.length, 0);
  } finally { controller.abort(); await app.close(); }
});
