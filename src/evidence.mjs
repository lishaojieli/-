import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './config.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export async function localFile(workspace, ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 500) throw new AppError('证据路径不正确。', 'EVIDENCE');
  const root = await realpath(workspace); const resolved = await realpath(path.resolve(root, ref));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new AppError('证据必须位于当前聊天工作目录内。', 'EVIDENCE');
  const info = await lstat(resolved); if (!info.isFile() || info.size > 2_000_000) throw new AppError('证据文件过大或不是普通文件。', 'EVIDENCE');
  const content = await readFile(resolved, 'utf8'); return { ref: path.relative(root, resolved), hash: digest(content), content };
}
export async function filesSnapshot(workspace) {
  const result = {}; let count = 0;
  async function walk(directory) {
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (path.resolve(filename).toLowerCase() === path.resolve(fileURLToPath(new URL('../data', import.meta.url))).toLowerCase()) continue;
      if (++count > 4000) throw new AppError('工作目录过大，无法可靠核对成果；请缩小任务目录。', 'ENVIRONMENT');
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) { const info = await lstat(filename); if (info.size <= 2_000_000) result[path.relative(workspace, filename)] = digest(await readFile(filename)); }
    }
  }
  await walk(workspace); return result;
}
export function reportFrom(text, required) {
  const match = text.match(/```room-progress\s*\n([\s\S]*?)\n```/);
  if (!match) { if (required) throw new AppError('成员未生成结构化进展记录，任务已暂停；不能凭口头结论继续。', 'PROGRESS_RECORD'); return null; }
  let report; try { report = JSON.parse(match[1]); } catch { throw new AppError('结构化进展记录不是有效 JSON，任务已暂停。', 'PROGRESS_RECORD'); }
  if (!report || !Array.isArray(report.progressItems) || !Array.isArray(report.evidenceRefs) || !Number.isInteger(report.taskRevision)) throw new AppError('结构化进展记录缺少必需字段。', 'PROGRESS_RECORD');
  const kinds = ['new_fact', 'issue_resolved', 'deliverable_changed', 'acceptance_advanced'];
  for (const item of report.progressItems) if (!kinds.includes(item.kind) || !(item.issueId || item.acceptanceId) || typeof item.ref !== 'string' || !Array.isArray(item.evidence)) throw new AppError('progressItems 格式不正确。', 'PROGRESS_RECORD');
  for (const key of ['deliverables', 'facts', 'reviews', 'issues', 'attempts', 'blockers']) if (report[key] !== undefined && !Array.isArray(report[key])) throw new AppError('结构化记录的列表格式不正确。', 'PROGRESS_RECORD');
  return report;
}

// Evidence is created by the scheduler from observed results, never from member-supplied hashes.
export function recordEvidence(task, value, author, revision = task.taskRevision) {
  const fingerprint = digest({ kind: value.kind, ref: value.ref, hash: value.hash, revision });
  const existing = task.evidence.find(item => item.fingerprint === fingerprint);
  if (existing) return { item: existing, fresh: false };
  const item = { id: 'ev-' + fingerprint.slice(0, 24), fingerprint, taskRevision: revision, author, time: new Date().toISOString(), ...value };
  task.evidence.push(item); return { item, fresh: true };
}
export function resolveRefs(task, refs) {
  if (!Array.isArray(refs)) return [];
  return task.evidence.filter(item => item.taskRevision === task.taskRevision && refs.includes(item.id));
}
export function evaluateAcceptance(task, report, author) {
  const advances = [];
  for (const review of report?.reviews || []) {
    const item = task.acceptance.find(item => item.id === review.acceptanceId);
    if (!item || item.status === 'passed' || review.verdict !== 'pass' || typeof review.basis !== 'string' || review.basis.trim().length < 12) continue;
    const refs = resolveRefs(task, review.evidenceRefs);
    const deliverables = refs.filter(ref => (ref.kind === 'deliverable' || ref.kind === 'file_change' || (item.type === 'implementation' && !item.requiresChange && ref.kind === 'fact')) && ref.author !== author && (ref.kind !== 'deliverable' || task.deliverableVersions?.[ref.ref] === ref.hash) && (!['file_change', 'fact'].includes(ref.kind) || task.fileHashes?.[ref.ref] === ref.hash));
    if (!deliverables.length) continue;
    if (item.check) {
      const check = refs.find(ref => ref.kind === 'check' && ref.acceptanceId === item.id && ref.passed === true && digest(ref.targetHashes) === digest(task.fileHashes));
      if (!check) continue;
    } else if (item.type === 'implementation' && (!deliverables.some(ref => (ref.kind === 'file_change' || (!item.requiresChange && ref.kind === 'fact')) && ref.hash !== 'deleted') || !refs.some(ref => ref.kind === 'check' && ref.passed && ref.acceptanceId === item.id && digest(ref.targetHashes) === digest(task.fileHashes)))) continue;
    item.status = 'passed'; item.taskRevision = task.taskRevision; item.evidenceRefs = refs.map(item => item.id);
    item.review = { author, basis: review.basis, time: new Date().toISOString(), taskRevision: task.taskRevision };
    const signature = digest({ revision: task.taskRevision, artifacts: deliverables.filter(ref => item.type !== 'implementation' || ref.kind !== 'deliverable').map(ref => [ref.ref, ref.hash]).sort() });
    item.passHistory ||= []; if (!item.passHistory.includes(signature)) { item.passHistory.push(signature); advances.push({ kind: 'acceptance_advanced', acceptanceId: item.id, ref: item.id, evidence: item.evidenceRefs }); }
  }
  return advances;
}
export const hasCompleted = task => task.acceptance.length > 0 && task.acceptance.every(item => !item.required || (item.status === 'passed' && item.taskRevision === task.taskRevision)) && !task.issues.some(item => item.required && item.status !== 'resolved');
