import { readFile, writeFile, mkdir, rename, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export class AppError extends Error {
  constructor(message, code = 'BAD_REQUEST', status = 400) { super(message); this.code = code; this.status = status; }
}
export const AGENTS = {
  codex: { name: 'Codex', initial: 'C', role: '执行 · 汇总', description: '把讨论变成成果，在指定工作目录中执行任务。' },
  deepseek: { name: 'DeepSeek', initial: 'D', role: '分析 · 审查', description: '拆解问题，检查逻辑，提出可验证的建议。' }
};
export const DEFAULTS = { codexPath: '', workspace: '', deepseekKey: '', deepseekModel: 'deepseek-flash' };
export const TARGET_MEMBERS = { all: ['deepseek', 'codex'], codex_deepseek: ['codex', 'deepseek'], codex: ['codex'], deepseek: ['deepseek'] };

function protect(value, decrypt = false) {
  if (process.platform !== 'win32') throw new AppError('此版本使用 Windows 本机凭据保护，请在 Windows 上运行。', 'PLATFORM', 500);
  const operation = decrypt
    ? '$taskBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $taskPlain=[Security.Cryptography.ProtectedData]::Unprotect($taskBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Text.Encoding]::UTF8.GetString($taskPlain))'
    : '$taskBytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $taskCipher=[Security.Cryptography.ProtectedData]::Protect($taskBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($taskCipher))';
  const script = "$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $null=[Reflection.Assembly]::LoadWithPartialName('System.Security'); " + operation;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output += chunk);
    child.on('error', () => reject(new AppError('无法打开本机凭据保护服务。', 'VAULT', 500)));
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new AppError('无法读取或保存本机密钥，请使用原 Windows 账号运行。', 'VAULT', 500)));
    child.stdin.end(value);
  });
}

export class Configuration {
  constructor(directory, options = {}) { this.directory = directory; this.value = { ...DEFAULTS, workspace: path.join(directory, '..', 'workspace'), ...options }; this.status = {}; }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try { const saved = JSON.parse(await protect(await readFile(path.join(this.directory, 'connections.encrypted'), 'utf8'), true)); this.value = { ...this.value, ...Object.fromEntries(Object.entries(saved).filter(([key]) => Object.hasOwn(DEFAULTS, key))) }; }
    catch (error) { if (error.code !== 'ENOENT') this.warning = '连接设置读取失败，请重新填写。聊天记录仍然保留。'; }
    if (!this.value.codexPath) this.value.codexPath = await discoverCodex();
    this.resetStatus();
  }
  resetStatus() {
    for (const id of Object.keys(AGENTS)) this.status[id] = { state: this.isConfigured(id) ? 'configured' : 'unconfigured', detail: this.isConfigured(id) ? '已配置，等待验证' : '需要连接设置' };
  }
  isConfigured(id) { return Object.hasOwn(AGENTS, id) && (id === 'codex' ? Boolean(this.value.codexPath) : Boolean(this.value[`${id}Key`] && this.value[`${id}Model`])); }
  public() {
    const { codexPath, workspace, deepseekModel, deepseekKey } = this.value;
    return { codexPath, workspace, deepseekModel, deepseekHasKey: Boolean(deepseekKey), status: this.status, warning: this.warning || null };
  }
  async save(input) {
    for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key)) throw new AppError('包含未知的连接设置。');
    const next = { ...this.value };
    for (const [key, value] of Object.entries(input)) {
      if (typeof value !== 'string' || value.length > 6000) throw new AppError('连接设置格式不正确。');
      if (key.endsWith('Key') && value.trim() === '') continue;
      next[key] = value.trim();
    }
    if (!next.deepseekModel || !/^[\w.:-]{1,150}$/.test(next.deepseekModel)) throw new AppError('请填写有效的模型 ID。');
    if (/\s/.test(next.deepseekKey)) throw new AppError('密钥中不能有空格或换行。');
    if (!path.isAbsolute(next.workspace)) throw new AppError('请选择完整的本机工作目录路径。');
    if (next.codexPath && (!path.isAbsolute(next.codexPath) || !next.codexPath.toLowerCase().endsWith('.exe'))) throw new AppError('请填写 Codex 可执行文件的完整路径。');
    if (next.codexPath) { try { await stat(next.codexPath); } catch { throw new AppError('找不到指定的 Codex 程序。'); } }
    if (JSON.stringify(next) === JSON.stringify(this.value) && !this.warning) return false;
    await mkdir(next.workspace, { recursive: true });
    const encoded = await protect(JSON.stringify(next));
    const filename = path.join(this.directory, 'connections.encrypted');
    await writeFile(filename + '.tmp', encoded, { mode: 0o600 }); await rename(filename + '.tmp', filename);
    this.value = next; this.warning = null; this.resetStatus(); return true;
  }
}

async function discoverCodex() {
  const directory = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const executable = path.join(directory, entry.name, 'codex.exe');
      try { candidates.push({ executable, modified: (await stat(executable)).mtimeMs }); } catch {}
    }
    return candidates.sort((a, b) => b.modified - a.modified)[0]?.executable || '';
  } catch { return ''; }
}
