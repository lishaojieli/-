import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Configuration, AGENTS, AppError } from './src/config.mjs';
import { RoomStore } from './src/store.mjs';
import { Providers } from './src/providers.mjs';
import { Room } from './src/room.mjs';
import { AccountMonitor } from './src/accounts.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export async function createApp({ directory = path.join(ROOT, 'data'), configuration, providers, store, schedulerOptions, accountPolling = !providers, port = Number(process.env.AGENT_ROOM_PORT || 4317) } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AppError('运行端口不正确。', 'CONFIG', 500);
  const config = configuration || new Configuration(directory); if (!configuration) await config.load();
  const repository = store || new RoomStore(directory);
  let room;
  const connectors = providers || new Providers(config, request => room.requestApproval(request));
  room = new Room(repository, config, connectors, schedulerOptions); await room.load();
  const accounts = new AccountMonitor(config, connectors); room.accounts = accounts;
  accounts.on('update', () => room.publish());
  room.on('agentSettled', id => { if (accountPolling) void accounts.refresh(id); });
  const session = randomBytes(32).toString('hex'); const streams = new Set();
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('请求格式不正确。', 'CONTENT_TYPE', 415);
    let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 80000) throw new AppError('消息太长。', 'TOO_LARGE', 413); }
    try { const result = JSON.parse(text); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; } catch { throw new AppError('请求内容格式不正确。'); }
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID(); const host = req.headers.host || ''; const address = server.address(); const currentPort = address?.port;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (![`127.0.0.1:${currentPort}`, `localhost:${currentPort}`].includes(host)) throw new AppError('仅允许本机访问。', 'HOST', 403);
      const url = new URL(req.url, `http://${host}`); const route = url.pathname;
      if (route === '/health' && req.method === 'GET') return json(res, { app: 'agent-room', status: 'ok', version: '1.0.0' });
      if (route === '/ready' && req.method === 'GET') return json(res, { status: 'ok' });
      if (route.startsWith('/api/')) {
        if (!req.headers.cookie?.split(';').some(value => value.trim() === `room_session=${session}`)) throw new AppError('页面连接已过期，请刷新聊天室。', 'AUTH', 401);
        if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new AppError('不允许跨站请求。', 'ORIGIN', 403);
        if (req.method !== 'GET' && req.headers['x-room-request'] !== '1') throw new AppError('请求来源不正确。', 'CSRF', 403);
        if (route === '/api/state' && req.method === 'GET') return json(res, room.snapshot());
        if (route === '/api/accounts/refresh' && req.method === 'POST') { await body(req); await accounts.refresh(); return json(res, accounts.snapshot()); }
        if (route === '/api/events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
          const send = value => res.write(`event: state\ndata: ${JSON.stringify(value)}\n\n`);
          send(room.snapshot()); room.on('state', send); streams.add(res);
          const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000); heartbeat.unref();
          res.on('close', () => { clearInterval(heartbeat); room.off('state', send); streams.delete(res); }); return;
        }
        if (route === '/api/messages' && req.method === 'POST') return json(res, { taskId: await room.post(await body(req)) }, 202);
        if (route === '/api/chats' && req.method === 'POST') { const input = await body(req); if (Object.keys(input).length) throw new AppError('新聊天请求格式不正确。'); return json(res, { chat: await room.createChat() }, 201); }
        if (route === '/api/control' && req.method === 'POST') { const input = await body(req); await room.control(input.action, input.chatId, input); return json(res, { ok: true }); }
        if (route === '/api/budget' && req.method === 'POST') { const input = await body(req); return json(res, await room.scheduler.configure(input.chatId, input)); }
        if (route === '/api/blockers' && req.method === 'POST') { const input = await body(req); await room.scheduler.answer(input.chatId, input); return json(res, { ok: true }); }
        if (route === '/api/settings' && req.method === 'POST') {
          if (room.running) throw new AppError('请先暂停任务，等待当前回复停止后再修改连接设置。', 'BUSY', 409);
          const changed = await config.save(await body(req)); if (changed) { accounts.invalidate(); connectors.close(); if (accountPolling) void accounts.refresh(); } room.publish(); return json(res, config.public());
        }
        const test = route.match(/^\/api\/connections\/(codex|deepseek)\/test$/);
        if (test && req.method === 'POST') {
          if (room.running) throw new AppError('请等待当前任务结束后再测试连接。', 'BUSY', 409);
          const id = test[1]; config.status[id] = { state: 'testing', detail: '正在测试' }; room.publish();
          try { const detail = await connectors.check(id); config.status[id] = { state: 'connected', detail }; room.publish(); if (accountPolling) void accounts.refresh(id); return json(res, { ok: true, detail }); }
          catch (error) { const detail = error instanceof AppError ? error.message : '连接测试失败，请检查网络和设置。'; config.status[id] = { state: 'error', detail }; room.publish(); throw new AppError(detail, 'CONNECTION', 502); }
        }
        const approval = route.match(/^\/api\/approvals\/([a-f0-9-]+)$/);
        if (approval && req.method === 'POST') { const input = await body(req); await room.answerApproval(approval[1], input.answer); return json(res, { ok: true }); }
        throw new AppError('找不到该操作。', 'NOT_FOUND', 404);
      }
      const files = { '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'], '/progress.mjs': ['progress.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method !== 'GET' || !files[route]) throw new AppError('页面不存在。', 'NOT_FOUND', 404);
      const [filename, type] = files[route];
      if (route === '/') res.setHeader('Set-Cookie', `room_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await readFile(path.join(ROOT, 'public', filename)));
    } catch (error) {
      process.stderr.write(JSON.stringify({ level: 'error', requestId, code: error.code || 'INTERNAL' }) + '\n');
      if (!res.headersSent) json(res, { error: { code: error.code || 'INTERNAL', message: error instanceof AppError ? error.message : '发生错误，请稍后重试。', requestId } }, error.status || 500); else res.end();
    }
  });
  async function listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); if (accountPolling) accounts.start(); return `http://127.0.0.1:${server.address().port}`; }
  async function close() { accounts.close(); try { await room.close(); } finally { for (const res of streams) res.end(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); } }
  return { server, room, config, connectors, accounts, listen, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp(); const url = await app.listen(); process.stdout.write(`Agent Room ready: ${url}\n`);
  const shutdown = () => app.close().finally(() => process.exit()); process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  if (app.config.isConfigured('codex')) app.connectors.check('codex').then(detail => { app.config.status.codex = { state: 'connected', detail }; app.room.publish(); }).catch(error => { app.config.status.codex = { state: 'error', detail: error instanceof AppError ? error.message : '请点击测试连接检查 Codex 登录状态' }; app.room.publish(); });
}
