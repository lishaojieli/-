import { spawn } from 'node:child_process';
import { localFile, digest } from './evidence.mjs';
import { AppError } from './config.mjs';

export async function executeCheck(check, workspace, signal) {
  if (check.type === 'file_contains') {
    const file = await localFile(workspace, check.path);
    return { passed: file.content.includes(check.includes), ref: file.ref, hash: file.hash, detail: '实际读取文件并检查所需内容' };
  }
  if (check.type !== 'node' || !Array.isArray(check.args) || !['--check', '--test'].includes(check.args[0]) || check.args.length < 2 || check.args.length > 20) throw new AppError('自动检查仅支持目录内文件检查及 Node 语法/测试检查。', 'CHECK_CONFIG');
  for (const filename of check.args.slice(1)) {
    if (typeof filename !== 'string' || filename.startsWith('-')) throw new AppError('检查参数不正确。', 'CHECK_CONFIG');
    await localFile(workspace, filename);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, check.args, { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const append = value => { output = (output + value.toString()).slice(-24000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const abort = () => child.kill(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.on('error', reject); child.on('close', code => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(signal.reason); else resolve({ passed: code === 0, exitCode: code, ref: 'node ' + check.args.join(' '), hash: digest(output), detail: output }); });
  });
}
