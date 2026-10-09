import { EventEmitter } from 'node:events';
import { AppError } from './config.mjs';

const IDS = ['codex', 'deepseek'];
const WINDOWS = { 300: 'fiveHour', 10080: 'weekly' };
const empty = () => ({ state: 'loading', refreshing: false, updatedAt: null, error: null, data: null });
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

// Map by the reported duration, rather than assuming primary always means five hours.
export function codexUsage(payload, previous = null, partial = false, now = new Date().toISOString()) {
  const buckets = payload?.rateLimitsByLimitId;
  const bucket = buckets && Object.hasOwn(buckets, 'codex') ? buckets.codex : payload?.rateLimits;
  if (!bucket || (bucket.limitId && bucket.limitId !== 'codex')) {
    if (partial) return null;
    throw new AppError('当前 Codex 账号未提供用量信息，请检查登录状态。', 'USAGE_UNAVAILABLE', 502);
  }
  const data = { fiveHour: null, weekly: null, ...(partial ? previous : {}) };
  for (const slot of ['primary', 'secondary']) {
    const window = bucket[slot]; const duration = number(window?.windowDurationMins); const key = Object.hasOwn(WINDOWS, duration) ? WINDOWS[duration] : null;
    if (!key) continue;
    const used = number(window.usedPercent); const reset = number(window.resetsAt);
    data[key] = { remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)), resetsAt: reset !== null && reset > 0 ? reset : null, windowDurationMins: window.windowDurationMins, updatedAt: now };
  }
  return data;
}

export function deepseekBalance(payload) {
  const decimal = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? value : null;
  if (typeof payload?.is_available !== 'boolean' || !Array.isArray(payload.balance_infos) || !payload.balance_infos.length) throw new AppError('DeepSeek 暂未提供有效余额数据。', 'BALANCE_RESPONSE', 502);
  const balances = payload.balance_infos.map(info => {
    const total = decimal(info.total_balance);
    if (!total || !/^[A-Z]{3}$/.test(info.currency || '')) throw new AppError('DeepSeek 暂未提供有效余额数据。', 'BALANCE_RESPONSE', 502);
    return { currency: info.currency, total, granted: decimal(info.granted_balance), toppedUp: decimal(info.topped_up_balance) };
  });
  return { available: payload.is_available, balances };
}

export class AccountMonitor extends EventEmitter {
  constructor(configuration, providers, { intervalMs = 30000 } = {}) {
    super(); this.configuration = configuration; this.providers = providers; this.intervalMs = intervalMs;
    this.values = { codex: empty(), deepseek: empty() }; this.pending = new Map(); this.epoch = 0; this.closed = false;
    this.notification = payload => {
      if (this.closed) return;
      const now = new Date().toISOString(); const data = codexUsage(payload, this.values.codex.data, true, now);
      if (data) { this.values.codex = { state: 'ready', refreshing: this.pending.has('codex'), data, updatedAt: now, error: null }; this.emit('update'); }
    };
    providers.codex?.on?.('rateLimits', this.notification);
    this.markUnconfigured();
  }
  snapshot() { return structuredClone({ ...this.values, refreshIntervalSeconds: this.intervalMs / 1000 }); }
  markUnconfigured() { for (const id of IDS) if (!this.configuration.isConfigured(id)) this.values[id] = { ...empty(), state: 'unconfigured' }; }
  start() { if (this.timer || this.closed) return; void this.refresh(); this.timer = setInterval(() => void this.refresh(), this.intervalMs); this.timer.unref(); }
  refresh(id) {
    if (this.closed) return Promise.resolve();
    if (!id) return Promise.all(IDS.map(member => this.refresh(member)));
    if (!IDS.includes(id)) return Promise.reject(new AppError('找不到该账户。', 'NOT_FOUND', 404));
    if (this.pending.has(id)) return this.pending.get(id);
    if (!this.configuration.isConfigured(id)) { this.values[id] = { ...empty(), state: 'unconfigured' }; this.emit('update'); return Promise.resolve(); }
    const epoch = this.epoch; const startingWindows = this.values[id].data;
    this.values[id].refreshing = true; this.emit('update');
    const promise = Promise.resolve().then(() => this.providers.accountData(id)).then(payload => {
      if (this.closed || this.epoch !== epoch) return;
      const now = new Date().toISOString(); const data = id === 'codex' ? codexUsage(payload, null, false, now) : deepseekBalance(payload);
      // Preserve a newer pushed window if it arrived while this read was in flight.
      if (id === 'codex') for (const key of ['fiveHour', 'weekly']) if (this.values[id].data?.[key] && this.values[id].data[key] !== startingWindows?.[key]) data[key] = this.values[id].data[key];
      this.values[id] = { state: 'ready', refreshing: true, data, updatedAt: now, error: null };
    }).catch(error => {
      if (this.closed || this.epoch !== epoch) return;
      this.values[id].state = 'error';
      this.values[id].error = error instanceof AppError ? error.message : `${id === 'codex' ? 'Codex 用量' : 'DeepSeek 余额'}查询失败，稍后会自动重试。`;
    }).finally(() => {
      if (this.closed || this.epoch !== epoch) return;
      this.pending.delete(id); this.values[id].refreshing = false; this.emit('update');
    });
    this.pending.set(id, promise); return promise;
  }
  invalidate() { this.epoch++; this.pending.clear(); this.values = { codex: empty(), deepseek: empty() }; this.markUnconfigured(); this.emit('update'); }
  close() { this.closed = true; this.epoch++; clearInterval(this.timer); this.providers.codex?.off?.('rateLimits', this.notification); }
}
