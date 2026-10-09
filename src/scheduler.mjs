import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir } from 'node:fs/promises';
import { AppError, AGENTS, TARGET_MEMBERS } from './config.mjs';
import { mentionedAgents } from './routing.mjs';
import { filesSnapshot, localFile, digest, reportFrom, recordEvidence, evaluateAcceptance, resolveRefs, hasCompleted } from './evidence.mjs';
import { executeCheck } from './checks.mjs';

export const DEFAULT_BUDGET = Object.freeze({ runRounds: 30, runActiveMs: 30 * 60000, sessionRounds: 100, sessionActiveMs: 120 * 60000 });
const reasons = { acceptance_complete: '全部必需验收项通过', fixed_rounds: '固定轮数结束，尚未通过全部验收', no_progress: '连续两轮没有实质进展', budget: '安全预算耗尽', waiting_user: '等待必要输入或用户决定', permission: '权限或环境阻塞', execution_error: '执行或进展记录生成失败', user_cancel: '用户取消', user_pause: '用户暂停', recovery: '服务重启，需核对检查点', uncertain_action: '执行结果不确定，需先核对实际副作用' };
function budget(input = {}, base = DEFAULT_BUDGET) {
  const value = { ...base, ...input };
  for (const [key, number] of Object.entries(value)) if (!Object.hasOwn(DEFAULT_BUDGET, key) || !Number.isSafeInteger(number) || number <= 0 || number > (key.endsWith('Rounds') ? 10000 : 30 * 24 * 3600000)) throw new AppError('预算必须是正整数，且不能超过配置上限。', 'BUDGET_CONFIG');
  return value;
}
function acceptanceFor(text, revision, input) {
  if (input !== undefined && (!Array.isArray(input) || !input.length || input.length > 40)) throw new AppError('至少提供一项验收要求，最多 40 项。', 'ACCEPTANCE');
  const writing = /方案|文案|提示词|计划|报告|文章|prompt|plan/i.test(text) && !/实现|修复|修改.*(?:代码|网页)|开发|implement|fix/i.test(text);
  const requirements = input || [{ description: text, type: !writing && /代码|实现|修复|网页|程序|开发|测试|implement|fix|code/i.test(text) ? 'implementation' : 'subjective' }];
  return requirements.map((item, index) => {
    if (typeof item.description !== 'string' || !item.description.trim() || item.description.length > (input ? 16000 : 512000) || (item.type && !['implementation', 'subjective'].includes(item.type))) throw new AppError('验收要求格式不正确。', 'ACCEPTANCE');
    if (item.check && !['file_contains', 'node'].includes(item.check.type)) throw new AppError('不支持此验收检查类型。', 'ACCEPTANCE');
    if (item.check?.type === 'file_contains' && (typeof item.check.path !== 'string' || typeof item.check.includes !== 'string' || !item.check.includes)) throw new AppError('文件验收检查缺少路径或内容。', 'ACCEPTANCE');
    if (item.check?.type === 'node' && (!Array.isArray(item.check.args) || !['--check', '--test'].includes(item.check.args[0]) || item.check.args.length < 2)) throw new AppError('Node 检查格式不正确。', 'ACCEPTANCE');
    return { id: 'accept-' + (index + 1), description: item.description.trim(), type: item.type || 'subjective', requiresChange: /实现|修复|修改|开发|implement|fix|modify/i.test(item.description), required: true, check: item.check || null, status: 'open', taskRevision: revision, source: { kind: 'user', taskRevision: revision }, evidenceRefs: [] };
  });
}
export class Scheduler {
  constructor(room, options = {}) {
    this.room = room; this.queue = Promise.resolve(); this.clock = options.clock || { mono: () => performance.now(), wall: () => Date.now() };
    this.tools = options.tools || { execute: executeCheck }; this.live = new Map(); this.persistFault = false;
    this.heartbeatMs = options.heartbeatMs || 1000; this.callTimeoutMs = options.callTimeoutMs || 15 * 60000;
  }
  session(chat) {
    if (!chat.scheduler) chat.scheduler = { config: { ...DEFAULT_BUDGET }, sessionRounds: 0, sessionActiveMs: 0, epoch: 0, actions: {}, reservations: [], clock: null, recoveryNeeded: false };
    return chat.scheduler;
  }
  async atomic(fn) {
    const operation = this.queue.then(async () => {
      if (this.persistFault) throw new AppError('持久层写入失败，禁止继续调度，请检查磁盘并重启服务。', 'PERSISTENCE', 500);
      let value; let failure; try { value = await fn(); } catch (error) { failure = error; }
      try { await this.room.save(); } catch (error) { this.persistFault = true; this.room.controller?.abort('persistence'); for (const task of this.room.state.tasks) if (['running', 'queued'].includes(task.status)) { task.status = 'paused'; task.stopReason = 'execution_error'; task.pauseReason = '持久层写入失败，预算记录无法安全提交。'; } this.room.publish(); throw error; }
      this.room.publish(); if (failure) throw failure; return value;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  charge(task) {
    const session = this.session(this.room.chat(task.chatId)); const live = this.live.get(task.id);
    if (!live) return;
    const current = this.clock.mono(); const delta = Math.max(0, current - live.last); live.last = current;
    task.run.activeMs += delta; session.sessionActiveMs += delta;
    session.clock = { running: true, taskId: task.id, runId: task.run.id, wall: this.clock.wall() };
  }
  beginClock(task) { this.live.set(task.id, { last: this.clock.mono() }); this.session(this.room.chat(task.chatId)).clock = { running: true, taskId: task.id, runId: task.run.id, wall: this.clock.wall() }; }
  endClock(task) { this.charge(task); this.live.delete(task.id); this.session(this.room.chat(task.chatId)).clock = { running: false, wall: this.clock.wall() }; }
  valid(task, epoch) { return !this.room.closed && task.status === 'running' && this.session(this.room.chat(task.chatId)).epoch === epoch; }
  exceeded(task) {
    const s = this.session(this.room.chat(task.chatId));
    if (s.sessionRounds > s.config.sessionRounds || s.sessionActiveMs >= s.config.sessionActiveMs) return '会话累计预算';
    if (task.run.rounds > s.config.runRounds || task.run.activeMs >= s.config.runActiveMs) return '本次运行预算';
    return null;
  }
  stop(task, status, reason, detail = '', next = '') {
    const s = this.session(this.room.chat(task.chatId)); this.endClock(task); s.epoch++;
    task.status = status; task.stopReason = reason; task.pauseReason = status === 'paused' ? detail || reasons[reason] : '';
    task.nextStep = next || (status === 'completed' ? '验收完成，可发布新任务。' : '核对暂停原因后，由你点击继续。');
    this.room.interruptTask(task, reason); this.room.add('system', status === 'completed' ? '已完成：全部必需验收项通过。' : `${status === 'cancelled' ? '已取消' : '暂停，尚未完成'}：${detail || reasons[reason]}。${task.nextStep}`, task.id);
  }
  async recover() {
    for (const chat of this.room.state.chats) {
      const historical = this.room.state.tasks.filter(task => task.chatId === chat.id && !task.schedulerVersion);
      const s = this.session(chat);
      if (historical.length && !s.migrated) {
        s.sessionRounds = historical.reduce((sum, task) => sum + new Set((task.steps || []).filter(step => step.status !== 'pending').map(step => step.round)).size, 0);
        s.sessionActiveMs = null; s.recoveryNeeded = true; s.migrated = true;
      }
      if (s.clock?.running) {
        const elapsed = this.clock.wall() - s.clock.wall;
        const task = this.room.state.tasks.find(task => task.id === s.clock.taskId);
        if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 30 * 24 * 3600000 && Number.isFinite(s.sessionActiveMs)) {
          s.sessionActiveMs += elapsed; if (task?.run) task.run.activeMs += elapsed;
        } else s.recoveryNeeded = true;
        s.clock = { running: false, wall: this.clock.wall() };
      }
      s.epoch++;
      for (const action of Object.values(s.actions)) if (action.status === 'started') action.status = 'uncertain';
      for (const task of this.room.state.tasks.filter(task => task.chatId === chat.id && ['running', 'queued'].includes(task.status))) {
        task.status = 'paused'; task.stopReason = 'recovery'; task.pauseReason = s.recoveryNeeded ? '历史计时缺失或调度端时钟不可靠，需要你恢复累计用时。' : '服务重启，已保留预算和检查点；请核对未确定的动作。'; task.nextStep = '核对实际成果和执行记录，再点击继续。';
        for (const step of task.steps || []) if (step.status === 'running') step.status = 'pending';
        this.room.add('system', '服务已重新启动。' + task.pauseReason, task.id);
      }
    }
    this.room.state.version = 3;
  }
  async post(input) {
    const { text, target = 'all', rounds = 1, mode = rounds === 'auto' ? 'auto' : 'fixed', newTask = false, chatId = this.room.state.currentChatId } = input;
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new AppError('请输入任务或补充要求，最多 16000 字。');
    if (!Object.hasOwn(TARGET_MEMBERS, target) || !['auto', 'fixed'].includes(mode) || (mode === 'fixed' && (!Number.isInteger(rounds) || rounds < 1 || rounds > 3)) || typeof newTask !== 'boolean') throw new AppError('任务设置不正确。');
    const mentions = mentionedAgents(text); let members = target === 'codex_deepseek' ? [...new Set([...mentions, ...TARGET_MEMBERS[target]])] : mentions.length ? mentions : [...TARGET_MEMBERS[target]];
    // Independent review is required for automatic completion, even for a singled-out author.
    if (mode === 'auto') members = [...new Set([...members, 'codex', 'deepseek'])];
    return this.atomic(() => {
      const chat = this.room.chat(chatId); const s = this.session(chat); let task = this.room.taskFor(chatId);
      if (input.requestId && s.requests?.[input.requestId]) return s.requests[input.requestId];
      if (input.requestId !== undefined && (typeof input.requestId !== 'string' || input.requestId.length > 100)) throw new AppError('请求标识不正确。');
      const prior = task?.schedulerVersion && !newTask && task.status !== 'cancelled' ? this.room.state.messages.filter(item => item.taskId === task.id && item.author === 'user').map(item => item.text).join('\n\n') : '';
      const criteria = acceptanceFor(prior ? prior + '\n\n用户最新补充（冲突时优先）：\n' + text.trim() : text.trim(), task?.schedulerVersion && !newTask ? task.taskRevision + 1 : 1, input.acceptance);
      if (input.budget) {
        if (task) throw new AppError('已有会话请通过预算设置显式修改额度。', 'BUDGET_CONFIG');
        s.config = budget(input.budget, s.config);
      }
      if (newTask && task && ['running', 'queued', 'paused'].includes(task.status)) this.stop(task, 'cancelled', 'user_cancel');
      if (!task?.schedulerVersion || newTask || task.status === 'cancelled') {
        task = { id: randomUUID(), chatId, title: text.trim().slice(0, 36), schedulerVersion: 1, status: 'queued', taskRevision: 1, revision: 1, mode, fixedRounds: mode === 'fixed' ? rounds : null, members, phase: 'clarify', steps: [], cursor: 0, failures: 0, createdAt: new Date().toISOString(), acceptance: criteria, acceptanceHistory: [], evidence: [], issues: [], rounds: [], checkpoint: null, noProgressRounds: 0, nextStep: '明确验收要求后，开始方案讨论。', run: { id: randomUUID(), rounds: 0, activeMs: 0 }, configuration: { target, mode, fixedRounds: mode === 'fixed' ? rounds : null } };
        this.room.state.tasks.push(task); chat.currentTaskId = task.id; s.epoch++;
      } else {
        const oldStatus = task.status; this.endClock(task); s.epoch++; this.room.interruptTask(task, 'update');
        task.acceptanceHistory.push({ taskRevision: task.taskRevision, acceptance: structuredClone(task.acceptance), sourceMessage: text.trim(), time: new Date().toISOString() });
        task.taskRevision++; task.revision = task.taskRevision; task.acceptance = criteria; task.members = members; task.mode = mode; task.fixedRounds = mode === 'fixed' ? rounds : null;
        task.checkpoint = null; task.fixedStartRounds = task.run.rounds; task.phase = 'clarify'; task.noProgressRounds = 0; task.issues = []; task.nextStep = '按新需求重新验收，已有成果和累计预算保留。';
        if (oldStatus === 'paused') task.status = 'paused'; else { task.status = 'queued'; if (oldStatus === 'completed') { task.run = { id: randomUUID(), rounds: 0, activeMs: 0 }; task.fixedStartRounds = 0; } }
        this.room.add('system', task.status === 'paused' ? '新要求已记录，验收已重开；需要你点击继续。' : '需求版本已更新，受影响的验收全部重开。', task.id);
      }
      if (s.recoveryNeeded) { task.status = 'paused'; task.stopReason = 'recovery'; task.pauseReason = '旧记录缺少可靠累计计时。请先在预算设置中恢复累计用时。'; }
      if (!this.room.state.messages.some(item => item.chatId === chatId && item.author === 'user')) chat.title = text.trim().slice(0, 36);
      this.room.state.currentChatId = chatId; this.room.state.currentTaskId = task.id; this.room.add('user', text.trim(), task.id);
      if (input.requestId) { s.requests ||= {}; s.requests[input.requestId] = task.id; }
      return task.id;
    }).then(id => { this.room.kick(); return id; });
  }
  async control(action, chatId, input = {}) {
    await this.atomic(async () => {
      const task = this.room.taskFor(chatId); const s = this.session(this.room.chat(chatId));
      if (!task?.schedulerVersion) throw new AppError('历史任务没有可靠预算，请发布新任务并恢复历史累计计时。', 'RECOVERY');
      if (input.epoch !== undefined && input.epoch !== s.epoch) throw new AppError('任务状态已变化，请刷新后操作。', 'STALE', 409);
      if (action === 'pause' && ['running', 'queued'].includes(task.status)) this.stop(task, 'paused', 'user_pause');
      else if (action === 'stop' && ['running', 'queued', 'paused'].includes(task.status)) this.stop(task, 'cancelled', 'user_cancel');
      else if (action === 'resume' && task.status === 'paused') {
        if (s.recoveryNeeded) throw new AppError('请先恢复缺失的累计计时。', 'RECOVERY');
        if (s.sessionRounds >= s.config.sessionRounds || s.sessionActiveMs >= s.config.sessionActiveMs) throw new AppError('会话累计预算已耗尽，需由你在预算设置中显式增加额度。', 'BUDGET', 409);
        const uncertain = Object.values(s.actions).filter(item => item.taskId === task.id && ['started', 'uncertain'].includes(item.status));
        if (uncertain.length) throw new AppError('有结果不确定的动作，请先核对并处理执行记录。', 'UNCERTAIN_ACTION', 409);
        if (task.issues.some(item => item.required && item.status === 'blocked' && item.blockType === 'user')) throw new AppError('请先提供所有必要答案，再继续。', 'WAITING_USER');
        for (const issue of task.issues.filter(item => item.status === 'blocked' && item.blockType === 'environment')) {
          if (!issue.check) throw new AppError('环境阻塞缺少可靠检查方法，请补充已恢复的条件及验证方式。', 'ENVIRONMENT');
          this.beginClock(task); let result;
          try { result = await this.tools.execute(issue.check, this.room.workspaceFor(chatId), AbortSignal.timeout(10000)); } finally { this.endClock(task); }
          if (!result.passed) throw new AppError('环境或权限条件仍未恢复。', 'ENVIRONMENT');
          issue.status = 'resolved'; const observed = recordEvidence(task, { kind: 'environment_check', ref: issue.id, hash: digest(result), passed: true, detail: result.detail }, 'scheduler').item;
          issue.evidenceRefs = [observed.id];
          if (task.checkpoint && !task.checkpoint.complete) task.checkpoint.progressItems.push({ kind: 'issue_resolved', issueId: issue.id, ref: issue.id, evidence: [observed.id] });
        }
        if (s.sessionActiveMs >= s.config.sessionActiveMs) throw new AppError('恢复检查已达到累计时间预算，请增加额度。', 'BUDGET', 409);
        s.epoch++; task.run = { id: randomUUID(), rounds: task.checkpoint && !task.checkpoint.complete ? 1 : 0, activeMs: 0 }; task.fixedStartRounds = 0; task.status = 'queued'; task.stopReason = null; task.pauseReason = ''; task.noProgressRounds = 0; task.nextStep = '从已保存的检查点继续。';
        this.room.add('system', '继续处理任务；只重置本次预算，累计预算保留。', task.id);
      } else throw new AppError('状态已变化，当前操作不能执行。', 'STATE', 409);
    });
    this.room.kick();
  }
  async configure(chatId, input) {
    return this.atomic(() => {
      const chat = this.room.chat(chatId); const s = this.session(chat); const task = this.room.taskFor(chatId);
      if (['running', 'queued'].includes(task?.status)) throw new AppError('请先暂停任务再修改预算。', 'BUSY', 409);
      if (input.budget) s.config = budget(input.budget, s.config);
      if (input.recoveredActiveMs !== undefined) {
        if (!s.recoveryNeeded || !Number.isSafeInteger(input.recoveredActiveMs) || input.recoveredActiveMs < 0) throw new AppError('恢复累计用时不正确。', 'RECOVERY');
        s.sessionActiveMs = Math.max(s.sessionActiveMs || 0, input.recoveredActiveMs); s.recoveryNeeded = false;
      }
      (s.configurationHistory ||= []).push({ source: 'user', time: new Date().toISOString(), input: structuredClone(input) }); return s;
    });
  }
  async answer(chatId, input) {
    return this.atomic(() => {
      const task = this.room.taskFor(chatId); const s = this.session(this.room.chat(chatId));
      if (task?.status !== 'paused') throw new AppError('请在暂停状态处理阻塞事项。', 'STATE');
      if (input.actionKey) {
        const action = s.actions[input.actionKey];
        if (!action || action.taskId !== task.id || action.status !== 'uncertain' || !['skip', 'retry'].includes(input.resolution) || typeof input.basis !== 'string' || input.basis.trim().length < 8) throw new AppError('请核对实际副作用并填写处理依据。', 'RECONCILIATION');
        action.reconciliation = { source: 'user', basis: input.basis, resolution: input.resolution, time: new Date().toISOString() };
        action.status = input.resolution === 'skip' ? 'skipped' : 'retry_authorized';
      } else {
        if (!input.answers || typeof input.answers !== 'object') throw new AppError('缺少必要答案。');
        for (const issue of task.issues.filter(item => item.status === 'blocked' && item.blockType === 'user')) {
          const answer = input.answers[issue.id]; if (typeof answer !== 'string' || !answer.trim()) throw new AppError('请集中回答所有必要问题。', 'WAITING_USER');
          issue.answer = answer; issue.status = 'resolved'; this.room.add('user', `${issue.description}\n答：${answer}`, task.id);
        }
      }
    });
  }
  async approval(request, task) {
    await this.atomic(() => {
      if (task.status !== 'running') { this.room.providers.codex.respond(request.rpcId, { decision: 'decline' }); return; }
      const params = request.params || {}; const scope = Object.fromEntries(Object.entries(params).filter(([key]) => !['threadId', 'turnId', 'itemId', 'approvalId'].includes(key)));
      const fingerprint = digest({ method: request.method, scope });
      const previous = task.issues.filter(item => item.requestFingerprint === fingerprint && item.status === 'resolved' && !item.consumed);
      if (previous.length) {
        if (request.method === 'item/tool/requestUserInput') this.room.providers.codex.respond(request.rpcId, { answers: Object.fromEntries(previous.map(item => [item.questionId, { answers: [item.answer] }])) });
        else this.room.providers.codex.respond(request.rpcId, { decision: previous[0].answer.trim() === '允许本次操作' ? 'accept' : 'decline' });
        for (const issue of previous) issue.consumed = true;
        return;
      }
      const questions = request.method === 'item/tool/requestUserInput' ? params.questions : [{ id: 'permission', question: `Codex 请求执行操作：${params.command || params.reason || '修改任务相关文件'}。允许时请准确填写“允许本次操作”；其他答案会拒绝。` }];
      for (const question of questions || []) task.issues.push({ id: `request-${fingerprint.slice(0, 12)}-${question.id}`, questionId: question.id, description: question.question, requestFingerprint: fingerprint, required: true, status: 'blocked', blockType: 'user', attempts: [] });
      if (request.method === 'item/tool/requestUserInput') this.room.providers.codex.respond(request.rpcId, null, { code: -32000, message: 'Paused for required user input.' });
      else this.room.providers.codex.respond(request.rpcId, { decision: 'decline' });
      this.stop(task, 'paused', request.method === 'item/tool/requestUserInput' ? 'waiting_user' : 'permission', questions.map(item => item.question).join('；'), '填写必要答案，并核对中断动作的实际结果，再点击继续。');
    });
  }
  prompt(task, author) {
    const round = task.checkpoint; const s = this.session(this.room.chat(task.chatId));
    return this.room.basePrompt(task, author) + `\n【调度规则】模式 ${task.mode}；taskRevision=${task.taskRevision}；阶段=${task.phase}；一轮是成员列表 ${task.members.join(' → ')} 各调用一次的完整周期。点名仅在计费周期中处理，不添加免费调用。最初最多讨论两轮；现在${task.phase === 'execute' || task.phase === 'repair' ? '必须执行任务、提供成稿或真实检查，不得继续纯讨论。常规实现分歧由 Codex 按任务约束决定。' : '明确验收要求并推进实际工作。'}\n所有验收项由用户约束生成，你不得删改或降级。只能提出 completionClaim，完成状态由调度层写入。另一成员审阅时必须引用实际成果与检查证据，逐项说明符合要求的依据；无法验证请说明原因。计划、承诺、重述、换话题不能算进展。只做当前指定步骤；不要重复已完成或不确定的动作。\n【必需验收项】${JSON.stringify(task.acceptance)}\n【真实证据（ID 可供引用）】${JSON.stringify(task.evidence.slice(-30))}\n【未决事项】${JSON.stringify(task.issues)}\n【执行记录】${JSON.stringify(Object.values(s.actions).filter(item => item.taskId === task.id).map(({ key, status, taskRevision }) => ({ key, status, taskRevision })))}\n【下一步】${task.nextStep}；本轮 ${round.number}。\n公开回复之后必须附一个有效的 JSON 代码块，代码块语言为 room-progress。格式：{ "taskRevision": ${task.taskRevision}, "completionClaim": false, "evidenceRefs": [], "progressItems": [], "deliverables": [], "facts": [], "reviews": [], "attempts": [], "issues": [], "blockers": [], "nextStep": "具体下一步" }。没有进展就保留空数组，不得虚构记录。progressItems 每项为 {kind: "new_fact|issue_resolved|deliverable_changed|acceptance_advanced", acceptanceId或issueId, ref, evidence:[真实证据ID]}。\n成稿 deliverables:[{name:"稿件名称",text:"完整正文"}]；读取代码事实 facts:[{path:"相对文件路径"}]（调度层实际读取核对）；真实自动检查 checkRequests:[{acceptanceId:"accept-1",check:{type:"node",args:["--test","tests/example.test.mjs"]}}]，仅用于用户授权的实现/验证任务。审阅 reviews:[{acceptanceId:"accept-1",verdict:"pass|unverifiable|fail",evidenceRefs:[已列出的ID],basis:"针对用户要求的具体依据"}]；自己不能验收自己的交付。未决 issues:[{id:"issue-1",description:"问题",required:true}]；尝试 attempts:[{issueId:"issue-1",strategy:"实际采用的策略",evidenceRefs:[真实ID],resolved:false}]；缺必要输入 blockers:[{id:"input-1",description:"所需输入及理由",type:"user|environment",check:可自动检查的恢复条件}]。不要输出 completed 状态。`;
  }
  async reserve(task) {
    const s = this.session(this.room.chat(task.chatId)); this.charge(task);
    if (this.exceeded(task)) { this.stop(task, 'paused', 'budget', this.exceeded(task)); return false; }
    if (task.checkpoint && !task.checkpoint.complete && task.checkpoint.taskRevision === task.taskRevision) return true;
    if (task.mode === 'fixed' && task.run.rounds - (task.fixedStartRounds || 0) >= task.fixedRounds) { this.stop(task, 'paused', 'fixed_rounds'); return false; }
    if (task.run.rounds >= s.config.runRounds || s.sessionRounds >= s.config.sessionRounds) { this.stop(task, 'paused', 'budget', s.sessionRounds >= s.config.sessionRounds ? '会话累计轮数预算耗尽' : '本次轮数预算耗尽'); return false; }
    const round = { id: randomUUID(), number: task.rounds.length + 1, taskRevision: task.taskRevision, epoch: s.epoch, members: [...task.members], index: 0, progressItems: [], complete: false };
    s.reservations.push({ roundId: round.id, taskId: task.id, runId: task.run.id, taskRevision: task.taskRevision }); s.sessionRounds++; task.run.rounds++;
    round.revisionRound = task.rounds.filter(item => item.taskRevision === task.taskRevision).length + 1;
    task.rounds.push(round); task.checkpoint = round;
    task.phase = round.revisionRound <= 2 ? 'discuss' : task.evidence.some(item => item.taskRevision === task.taskRevision && item.kind === 'check' && !item.passed) ? 'repair' : task.evidence.some(item => item.taskRevision === task.taskRevision && ['file_change', 'deliverable'].includes(item.kind)) ? 'verify' : 'execute';
    return true;
  }
  async incorporate(task, author, report, before, after, events) {
    const round = task.checkpoint; const fresh = []; const evidence = [];
    task.fileHashes = after;
    for (const item of task.acceptance) if (item.status === 'passed' && item.evidenceRefs.some(id => { const ref = task.evidence.find(ref => ref.id === id); return ref && ((['file_change', 'fact'].includes(ref.kind) && after[ref.ref] !== ref.hash) || (ref.kind === 'check' && digest(ref.targetHashes) !== digest(after))); })) { item.status = 'open'; item.verificationReason = '成果版本变化，旧检查不再证明当前成果。'; }
    const add = value => { const saved = recordEvidence(task, value, author); evidence.push(saved.item); if (saved.fresh) fresh.push(saved.item); return saved.item; };
    for (const [ref, hash] of Object.entries(after)) if (before[ref] !== hash) add({ kind: 'file_change', ref, hash });
    for (const [ref] of Object.entries(before)) if (!Object.hasOwn(after, ref)) add({ kind: 'file_change', ref, hash: 'deleted' });
    for (const event of events) {
      if (event.type === 'commandExecution' && event.status === 'completed' && typeof event.exitCode === 'number') add({ kind: 'tool_result', ref: event.command || event.id, hash: digest({ command: event.command, exitCode: event.exitCode, output: event.aggregatedOutput }), exitCode: event.exitCode, detail: String(event.aggregatedOutput || '').slice(-12000) });
    }
    if (!report) return;
    if (report.taskRevision !== task.taskRevision) throw new AppError('进展记录引用了旧需求版本。', 'PROGRESS_RECORD');
    for (const item of report.deliverables || []) { if (typeof item.name !== 'string' || typeof item.text !== 'string' || !item.text.trim()) throw new AppError('交付物必须包含实际成稿。', 'PROGRESS_RECORD'); const hash = digest(item.text); task.deliverableVersions ||= {}; task.deliverableVersions[item.name] = hash; add({ kind: 'deliverable', ref: item.name, hash, content: item.text }); }
    for (const item of report.facts || []) { const file = await localFile(this.room.workspaceFor(task.chatId), item.path); add({ kind: 'fact', ref: file.ref, hash: file.hash, detail: file.content.slice(0, 8000) }); }
    for (const item of fresh.filter(item => ['file_change', 'fact'].includes(item.kind) || (item.kind === 'deliverable' && task.acceptance.some(item => item.type === 'subjective')))) round.progressItems.push({ kind: item.kind === 'fact' ? 'new_fact' : 'deliverable_changed', acceptanceId: task.acceptance[0].id, ref: item.ref, evidence: [item.id] });
    // Model proposals may open issues, but cannot remove or downgrade existing required issues.
    for (const proposed of report.issues || []) {
      if (typeof proposed.id !== 'string' || typeof proposed.description !== 'string') throw new AppError('未决事项记录不正确。', 'PROGRESS_RECORD');
      if (!task.issues.some(item => item.id === proposed.id)) task.issues.push({ id: proposed.id, description: proposed.description, required: proposed.required !== false, status: 'open', attempts: [], stagnantAttempts: 0 });
    }
    for (const attempt of report.attempts || []) {
      const issue = task.issues.find(item => item.id === attempt.issueId); if (!issue) throw new AppError('尝试记录引用未知事项。', 'PROGRESS_RECORD');
      const refs = resolveRefs(task, attempt.evidenceRefs); const unseen = refs.filter(ref => !(issue.evidenceRefs || []).includes(ref.id));
      const strategy = typeof attempt.strategy === 'string' ? attempt.strategy : ''; const strategyFingerprint = digest(strategy.trim().replace(/\s+/g, ' '));
      // A strategy change without a new observed result cannot establish progress or clear stagnation.
      issue.stagnantAttempts = unseen.length ? 0 : issue.stagnantAttempts + 1;
      issue.attempts.push({ strategy, strategyFingerprint, evidenceSummary: refs.map(ref => ({ id: ref.id, hash: ref.hash })), taskRevision: task.taskRevision, roundId: round.id });
      issue.evidenceRefs = [...new Set([...(issue.evidenceRefs || []), ...refs.map(ref => ref.id)])];
      if (attempt.resolved && unseen.some(ref => ref.kind === 'check' && ref.passed)) { if (issue.status !== 'resolved') round.progressItems.push({ kind: 'issue_resolved', issueId: issue.id, ref: issue.id, evidence: unseen.map(ref => ref.id) }); issue.status = 'resolved'; }
      else if (issue.stagnantAttempts >= 2) issue.status = 'stalled';
    }
    for (const blocked of report.blockers || []) {
      if (typeof blocked.id !== 'string' || typeof blocked.description !== 'string' || !['user', 'environment'].includes(blocked.type)) throw new AppError('缺口记录不正确。', 'PROGRESS_RECORD');
      let issue = task.issues.find(item => item.id === blocked.id); if (!issue) { issue = { id: blocked.id, description: blocked.description, required: true, attempts: [] }; task.issues.push(issue); }
      issue.status = 'blocked'; issue.blockType = blocked.type; issue.check = blocked.check || null;
    }
    const advances = evaluateAcceptance(task, report, author); round.progressItems.push(...advances);
    task.completionClaims ||= []; if (report.completionClaim) task.completionClaims.push({ author, taskRevision: task.taskRevision, evidenceRefs: report.evidenceRefs, roundId: round.id });
    for (const review of report.reviews || []) if (review.verdict !== 'pass') { const item = task.acceptance.find(item => item.id === review.acceptanceId); if (item && item.status !== 'passed') item.verificationReason = review.basis || '成员未提供可验证依据'; }
    if (typeof report.nextStep === 'string' && report.nextStep.trim()) task.nextStep = report.nextStep;
    if (task.evidence.some(item => item.taskRevision === task.taskRevision && ['deliverable', 'file_change'].includes(item.kind))) task.phase = 'verify';
  }
  async checkRequests(task, report, epoch, controller) {
    for (const request of report?.checkRequests || []) {
      if (!this.valid(task, epoch)) return;
      const criterion = task.acceptance.find(item => item.id === request.acceptanceId);
      if (!criterion || criterion.type !== 'implementation') throw new AppError('自动执行检查必须关联用户授权的实现验收项。', 'CHECK_CONFIG');
      const check = criterion.check || request.check;
      const hashes = await filesSnapshot(this.room.workspaceFor(task.chatId));
      const key = `check:${task.id}:${task.taskRevision}:${criterion.id}:${digest({ check, hashes })}`; const s = this.session(this.room.chat(task.chatId));
      let execute = false;
      await this.atomic(() => { if (!this.valid(task, epoch)) return; const old = s.actions[key]; if (old?.status === 'completed' || old?.status === 'skipped') return; if (old?.status === 'uncertain' || old?.status === 'started') throw new AppError('检查动作结果不确定，需要先核对。', 'UNCERTAIN_ACTION'); s.actions[key] = { key, taskId: task.id, taskRevision: task.taskRevision, type: 'check', status: 'started', check, acceptanceId: criterion.id, targetHashes: hashes }; execute = true; });
      if (!execute) continue;
      try {
        const result = await this.tools.execute(check, this.room.workspaceFor(task.chatId), controller.signal);
        await this.atomic(() => {
          const action = s.actions[key]; if (!this.valid(task, epoch)) { action.status = 'uncertain'; action.observedResult = result; return; }
          action.status = 'completed'; action.result = result;
          recordEvidence(task, { kind: 'check', ref: key, hash: digest({ check, hashes, result }), targetHashes: hashes, acceptanceId: criterion.id, passed: result.passed === true, detail: result.detail, exitCode: result.exitCode }, 'scheduler');
        });
      } catch (error) { await this.atomic(() => { s.actions[key].status = 'uncertain'; }); throw error; }
    }
  }
  async execute(task) {
    await this.atomic(() => { if (task.status !== 'queued' && task.status !== 'running') return; const s = this.session(this.room.chat(task.chatId)); if (Object.values(s.actions).some(item => item.taskId === task.id && item.status === 'uncertain')) { this.stop(task, 'paused', 'uncertain_action'); return; } task.status = 'running'; this.beginClock(task); });
    const heartbeat = setInterval(() => { void this.atomic(() => { if (task.status !== 'running') return; this.charge(task); const exceeded = this.exceeded(task); if (exceeded) this.stop(task, 'paused', 'budget', exceeded); }).catch(() => {}); }, this.heartbeatMs);
    let controller;
    try {
      while (task.status === 'running' && !this.room.closed) {
        let ready = false; await this.atomic(async () => { if (task.status === 'running') ready = await this.reserve(task); }); if (!ready) break;
        const round = task.checkpoint;
        const replay = Object.values(this.session(this.room.chat(task.chatId)).actions).filter(item => item.taskId === task.id && item.taskRevision === task.taskRevision && item.type === 'check' && item.status === 'retry_authorized');
        for (const action of replay) {
          const epoch = this.session(this.room.chat(task.chatId)).epoch; controller = new AbortController(); this.room.controller = controller;
          try { await this.checkRequests(task, { checkRequests: [{ acceptanceId: action.acceptanceId, check: action.check }] }, epoch, controller); }
          catch (error) { await this.atomic(() => { if (this.valid(task, epoch)) this.stop(task, 'paused', 'execution_error', error.message); }); }
          finally { this.room.controller = null; }
        }
        if (task.status !== 'running') break;
        if (round.index >= round.members.length) { await this.atomic(() => this.finishRound(task)); continue; }
        const author = round.members[round.index];
        const s = this.session(this.room.chat(task.chatId)); const epoch = s.epoch; const actionKey = `member:${task.id}:${task.taskRevision}:${round.id}:${round.index}`;
        if (!this.room.configuration.isConfigured(author)) { await this.atomic(() => this.stop(task, 'paused', 'permission', `${AGENTS[author]?.name || author} 尚未连接`, '完成连接设置后继续。')); break; }
        let message; let doCall = false; const callId = randomUUID(); controller = new AbortController(); this.room.controller = controller;
        await mkdir(this.room.workspaceFor(task.chatId), { recursive: true });
        const before = await filesSnapshot(this.room.workspaceFor(task.chatId));
        await this.atomic(() => {
          if (!this.valid(task, epoch)) return;
          const previous = s.actions[actionKey];
          if (['completed', 'skipped'].includes(previous?.status)) { round.index++; return; }
          if (['started', 'uncertain'].includes(previous?.status)) { this.stop(task, 'paused', 'uncertain_action'); return; }
          s.actions[actionKey] = { key: actionKey, taskId: task.id, taskRevision: task.taskRevision, type: 'member', author, status: 'started', epoch, callId, before };
          message = this.room.add(author, '', task.id, 'streaming');
          task.steps.push({ agent: author, round: round.number, roundId: round.id, actionKey, status: 'running', callId }); doCall = true;
        });
        if (doCall) {
          const events = []; const timeout = setTimeout(() => controller.abort(new AppError('成员调用超时。', 'TIMEOUT')), this.callTimeoutMs);
          try {
            const result = await this.room.providers.run(author, this.prompt(task, author), { chatId: task.chatId, workspace: this.room.workspaceFor(task.chatId), signal: controller.signal, epoch, callId, actionKey,
              onDelta: delta => { if (this.valid(task, epoch) && !controller.signal.aborted && s.actions[actionKey]?.callId === callId && s.actions[actionKey]?.status === 'started' && message.status === 'streaming') { message.text += delta; this.room.publish(false); } },
              onActivity: item => { if (this.valid(task, epoch) && !controller.signal.aborted && s.actions[actionKey]?.status === 'started') { this.room.add('system', `Codex：正在执行 ${item.type}${item.command ? '\n' + item.command : ''}`, task.id); this.room.publish(); } },
              onToolResult: item => { if (this.valid(task, epoch) && !controller.signal.aborted && s.actions[actionKey]?.callId === callId && s.actions[actionKey]?.status === 'started' && !events.some(old => old.id === item.id)) events.push(structuredClone(item)); }
            });
            if (typeof result !== 'string') throw new AppError('成员回复格式不正确。', 'PROGRESS_RECORD');
            const after = await filesSnapshot(this.room.workspaceFor(task.chatId));
            const report = reportFrom(result, task.mode === 'auto');
            await this.atomic(async () => {
              const action = s.actions[actionKey]; if (!this.valid(task, epoch) || controller.signal.aborted || action.callId !== callId || action.status !== 'started') { action.status = author === 'deepseek' ? 'retry_authorized' : 'uncertain'; action.observedResult = { text: result, before, after, events }; message.status = 'interrupted'; return; }
              message.text = result.replace(/```room-progress\s*\n[\s\S]*?\n```/, '').trim();
              for (const item of report?.deliverables || []) if (typeof item.text === 'string' && !message.text.includes(item.text)) message.text += `\n\n${item.name}\n${item.text}`;
              message.status = 'complete';
              await this.incorporate(task, author, report, before, after, events);
              action.status = 'completed'; action.result = { messageId: message.id, evidenceRefs: task.evidence.map(item => item.id) };
              task.steps.find(item => item.callId === callId).status = 'complete'; task.cursor++; round.index++;
            });
            await this.checkRequests(task, report, epoch, controller);
          } catch (error) {
            await this.atomic(() => {
              const action = s.actions[actionKey]; if (action.status === 'started') action.status = author === 'deepseek' ? 'retry_authorized' : 'uncertain';
              message.status = 'interrupted'; action.error = error?.code || 'CALL_INTERRUPTED';
              if (this.valid(task, epoch)) this.stop(task, 'paused', error?.code === 'UNCERTAIN_ACTION' ? 'uncertain_action' : 'execution_error', error instanceof AppError ? error.message : '成员或工具执行失败，保留已完成成果及检查点。');
            });
          } finally { clearTimeout(timeout); this.room.cancelApprovals(task.id); if (this.room.controller === controller) this.room.controller = null; this.room.emit('agentSettled', author); }
        }
        await this.atomic(() => {
          if (!this.valid(task, epoch)) return;
          if (hasCompleted(task)) { this.stop(task, 'completed', 'acceptance_complete'); return; }
          const blocked = task.issues.filter(item => item.required && item.status === 'blocked');
          if (blocked.length) { this.stop(task, 'paused', blocked.some(item => item.blockType === 'user') ? 'waiting_user' : 'permission', blocked.map(item => item.description).join('；'), '集中补齐这些缺口，再继续。'); return; }
          if (round.index >= round.members.length && !round.complete) this.finishRound(task);
        });
      }
    } finally { clearInterval(heartbeat); await this.atomic(() => this.endClock(task)); }
  }
  finishRound(task) {
    const round = task.checkpoint; if (round.complete) return;
    round.complete = true; round.finishedAt = new Date().toISOString(); round.progressItems = [...new Map(round.progressItems.map(item => [digest(item), item])).values()];
    task.noProgressRounds = round.progressItems.length ? 0 : task.noProgressRounds + 1;
    if (task.mode === 'auto' && task.noProgressRounds >= 2) this.stop(task, 'paused', 'no_progress');
    else if (task.mode === 'auto' && round.revisionRound >= 3 && !task.evidence.some(item => item.taskRevision === task.taskRevision && ['deliverable', 'file_change', 'check', 'tool_result', 'fact'].includes(item.kind))) this.stop(task, 'paused', 'no_progress', '两轮讨论后仍未落实交付、执行或验证');
    else if (task.issues.some(item => item.required && item.status === 'stalled') && !task.issues.some(item => item.status === 'open')) this.stop(task, 'paused', 'no_progress', '必需事项停滞，且没有可独立推进的下一步');
  }
  async close() { await this.atomic(() => { for (const task of this.room.state.tasks) if (task.schedulerVersion && ['running', 'queued'].includes(task.status)) this.stop(task, 'paused', 'user_pause', '服务关闭，已保存检查点'); }); }
}
