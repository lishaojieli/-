import { progressView } from './progress.mjs';
const $ = id => document.getElementById(id);
const escapeHTML = text => String(text ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
let state = null; let selectedChatId = null; let lastRenderedChatId = null; let creatingChat = false; let submitting = false; let toastTimer; let source;
const drafts = new Map(); const approvalDrafts = new Map();
try { selectedChatId = localStorage.getItem('agent-room-chat'); } catch {}
let refreshingAccounts = false;
const statusNames = { unconfigured: '未连接', configured: '已配置', testing: '测试中', connected: '已连接', error: '异常' };
const taskNames = { running: '正在协作', queued: '排队中', paused: '暂停，尚未完成', completed: '已完成（验收通过）', cancelled: '已取消', complete: '历史讨论已结束', partial: '历史讨论部分结束', failed: '未完成', stopped: '已结束' };
const stepNames = { pending: '等待处理', running: '正在回复', complete: '回复完成', failed: '未完成' };
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4500); }
async function api(route, value) {
  const response = await fetch(route, value === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Room-Request': '1' }, body: JSON.stringify(value) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || '操作失败，请稍后重试。'); return result;
}
function timeLabel(time) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }).format(new Date(time)); }
function currentChat() { return state?.chats?.find(chat => chat.id === selectedChatId); }
function currentTask() { return state?.tasks.find(task => task.id === currentChat()?.currentTaskId); }
function renderRunStatus(task) { const content = progressView(task, currentChat()?.scheduler, escapeHTML); $('runStatus').innerHTML = content; $('runStatus').classList.toggle('hidden', !content); $('autoHelp').classList.toggle('hidden', $('rounds').value !== 'auto'); }
let budgetChatId; let blockerChatId;
function openBudget() {
  budgetChatId = selectedChatId; const session = currentChat()?.scheduler; if (!session) return;
  $('budgetFields').innerHTML = [['runRounds', '本次最多轮数', 1], ['runActiveMs', '本次最多分钟', 60000], ['sessionRounds', '累计最多轮数', 1], ['sessionActiveMs', '累计最多分钟', 60000]].map(([key, label, divisor]) => `<label>${label}<input type="number" min="1" step="1" required name="${key}" value="${session.config[key] / divisor}"></label>`).join('') + (session.recoveryNeeded ? '<label>恢复历史累计用时（分钟；请填写已核对的上限）<input type="number" min="0" step="1" required name="recoveredActiveMs" value="120"></label><p>旧版本没有记录有效用时，未恢复前任务保持暂停，不会自动归零。</p>' : '');
  $('budgetError').textContent = ''; $('budgetDialog').showModal();
}
function openBlockers() {
  blockerChatId = selectedChatId; const task = currentTask(); const session = currentChat()?.scheduler;
  const issues = task.issues.filter(item => item.status === 'blocked' && item.blockType === 'user');
  const actions = Object.values(session.actions).filter(item => item.taskId === task.id && item.status === 'uncertain');
  $('blockerFields').innerHTML = issues.map(item => `<label>${escapeHTML(item.description)}<input required name="answer:${escapeHTML(item.id)}"></label>`).join('') + actions.map(item => `<fieldset><legend>结果不确定：${escapeHTML(item.author || '检查工具')}</legend><p>${escapeHTML(item.key)}</p><label>核对实际成果及副作用后选择<select name="resolve:${escapeHTML(item.key)}"><option value="skip">已核对，跳过该动作</option><option value="retry">已核对，显式允许重试</option></select></label><label>核对依据（至少 8 字）<input required minlength="8" name="basis:${escapeHTML(item.key)}"></label></fieldset>`).join('') + (!issues.length && !actions.length ? '<p>没有待填答案或不确定动作。环境阻塞会在继续时重新检查；缺少检查方式时，请补充要求。</p>' : '');
  $('blockerError').textContent = ''; $('blockerDialog').showModal();
}
function sortedChats() { return [...(state?.chats || [])].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)); }
function rememberDraft() { if (selectedChatId) drafts.set(selectedChatId, { text: $('message').value, target: $('target').value, rounds: $('rounds').value, scrollTop: $('chat').scrollTop }); }
function selectChat(id) {
  if (!state?.chats.some(chat => chat.id === id) || id === selectedChatId) return;
  rememberDraft(); selectedChatId = id; try { localStorage.setItem('agent-room-chat', id); } catch {}
  const draft = drafts.get(id); $('message').value = draft?.text || ''; $('target').value = draft?.target || 'all'; $('rounds').value = draft?.rounds || (currentTask()?.mode === 'auto' ? 'auto' : String(currentTask()?.fixedRounds || 1)); render();
  document.querySelector(`[data-chat="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}
async function createChat() {
  if (creatingChat || !state) return;
  if (currentChat() && !state.messages.some(message => message.chatId === selectedChatId) && !currentTask()) { $('message').focus(); return; }
  creatingChat = true; for (const id of ['newChat', 'newChatMobile']) $(id).disabled = true;
  try { const result = await api('/api/chats', {}); state = await api('/api/state'); selectChat(result.chat.id); $('message').focus(); }
  catch (error) { toast(error.message); }
  finally { creatingChat = false; for (const id of ['newChat', 'newChatMobile']) $(id).disabled = false; }
}
function resetLabel(seconds) {
  if (!seconds) return '暂未提供重置时间';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(seconds * 1000)).replace('/', '-');
}
function accountCaption(account, updatedAt = account?.updatedAt) {
  if (account?.state === 'unconfigured') return '请先设置连接';
  if (account?.state === 'error') return `${account.data ? '更新失败 · 上次数据' : '查询失败'}${updatedAt ? ' ' + timeLabel(updatedAt) : ''}`;
  if (!updatedAt) return account?.refreshing || account?.state === 'loading' ? '正在查询…' : '暂未提供数据';
  return `${account?.refreshing ? '更新中' : '更新于'} ${timeLabel(updatedAt)}`;
}
function moneyLabel(value, currency) { return `${({ CNY: '¥', USD: '$' })[currency] || currency + ' '}${value}`; }
function renderAccounts() {
  const accounts = state?.accounts; const codex = accounts?.codex; const deepseek = accounts?.deepseek;
  $('usageCards').innerHTML = [['fiveHour', 'Codex · 5 小时剩余'], ['weekly', 'Codex · 周剩余']].map(([key, label]) => {
    const window = codex?.data?.[key]; const percent = window?.remainingPercent;
    const known = typeof percent === 'number'; const value = known ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(percent) + '<span>%</span>' : '—';
    const caption = accountCaption(codex, window?.updatedAt || codex?.updatedAt);
    const details = `${label}：${known ? percent + '%' : '暂未提供'}\n重置时间：${resetLabel(window?.resetsAt)}（北京时间）\n${caption}${codex?.error ? '\n' + codex.error : ''}`;
    return `<article class="usage-card usage-state-${codex?.state || 'loading'} ${codex?.state === 'error' ? 'stale' : ''}" tabindex="0" title="${escapeHTML(details)}"><div class="usage-label">${label}</div><div class="usage-value">${value}</div><progress class="usage-bar ${known ? '' : 'usage-unknown'}" max="100" value="${known ? percent : 0}" aria-label="${label}" ${known ? '' : 'aria-hidden="true"'}></progress><div class="usage-reset">${window?.resetsAt ? `重置 ${resetLabel(window.resetsAt)}<span class="reset-countdown" data-reset-at="${window.resetsAt}"></span>` : '暂未提供重置时间'}</div><div class="usage-caption" data-updated-at="${escapeHTML(window?.updatedAt || codex?.updatedAt || '')}">${escapeHTML(caption)}</div>${codex?.error ? `<div class="usage-error">${escapeHTML(codex.error)}</div>` : ''}</article>`;
  }).join('') + `<article class="usage-card balance-card usage-state-${deepseek?.state || 'loading'} ${deepseek?.state === 'error' ? 'stale' : ''}" tabindex="0" title="${escapeHTML(`DeepSeek 账户余额（赠送 + 充值）\n${deepseek?.data?.balances.map(balance => `${balance.currency}：${moneyLabel(balance.total, balance.currency)}\n赠送 ${balance.granted === null ? '暂未提供' : moneyLabel(balance.granted, balance.currency)} · 充值 ${balance.toppedUp === null ? '暂未提供' : moneyLabel(balance.toppedUp, balance.currency)}`).join('\n') || '暂未提供'}\n${accountCaption(deepseek)}${deepseek?.error ? '\n' + deepseek.error : ''}`)}"><div class="usage-label">DeepSeek · 账户余额</div><div class="balance-values">${deepseek?.data?.balances.map(balance => `<div class="usage-value">${escapeHTML(moneyLabel(balance.total, balance.currency))}<span class="currency-code">${balance.currency}</span></div><div class="balance-breakdown">赠送 ${escapeHTML(balance.granted === null ? '—' : moneyLabel(balance.granted, balance.currency))} · 充值 ${escapeHTML(balance.toppedUp === null ? '—' : moneyLabel(balance.toppedUp, balance.currency))}</div>`).join('') || '<div class="usage-value">—</div>'}</div>${deepseek?.data?.available === false ? '<div class="usage-error">当前余额不可用</div>' : ''}<div class="usage-caption">${escapeHTML(accountCaption(deepseek))}</div>${deepseek?.error ? `<div class="usage-error">${escapeHTML(deepseek.error)}</div>` : ''}</article>`;
  const refreshing = refreshingAccounts || Boolean(codex?.refreshing || deepseek?.refreshing);
  $('refreshAccounts').disabled = refreshing; $('refreshAccounts').textContent = refreshing ? '…' : '↻';
  $('refreshAccounts').title = `刷新账户用量与余额 · 每 ${accounts?.refreshIntervalSeconds || 30} 秒自动更新 · 重置时间为北京时间`;
  updateCountdowns();
}
function updateCountdowns() {
  for (const element of document.querySelectorAll('[data-reset-at]')) {
    const minutes = Math.ceil((Number(element.dataset.resetAt) * 1000 - Date.now()) / 60000);
    if (minutes <= 0) element.textContent = '等待更新';
    else {
      const days = Math.floor(minutes / 1440); const hours = Math.floor(minutes % 1440 / 60); const rest = minutes % 60;
      element.textContent = `${days ? days + '天 ' : ''}${hours ? hours + '小时 ' : ''}${rest || (!days && !hours) ? rest + '分钟' : ''}后`;
    }
    const card = element.closest('.usage-card'); card.title = card.title.split('\n距重置：')[0] + '\n距重置：' + element.textContent;
  }
}
function render() {
  if (!state) return;
  if (!currentChat()) { selectedChatId = state.currentChatId || state.chats?.at(-1)?.id || null; try { if (selectedChatId) localStorage.setItem('agent-room-chat', selectedChatId); } catch {} }
  if (lastRenderedChatId !== selectedChatId && !drafts.has(selectedChatId)) { $('rounds').value = currentTask()?.mode === 'auto' ? 'auto' : String(currentTask()?.fixedRounds || 1); $('target').value = currentTask()?.configuration?.target || 'all'; }
  renderAccounts();
  $('members').innerHTML = Object.entries(state.agents).map(([id, agent]) => `<button class="member" data-member="${id}" title="向 ${escapeHTML(agent.name)} 发布任务"><span class="avatar ${id}">${agent.initial}</span><span class="member-text"><span class="member-name">${agent.name}</span><span class="member-subtitle">${agent.role} · ${statusNames[state.connections.status[id]?.state] || '未连接'}</span></span><span class="state-dot ${state.connections.status[id]?.state || ''}"></span></button>`).join('');
  const historyScroll = $('history').scrollTop;
  $('history').innerHTML = sortedChats().map(chat => {
    const task = state.tasks.find(task => task.id === chat.currentTaskId); const needsInput = state.approvals.some(item => item.chatId === chat.id);
    const status = needsInput ? '等你确认' : task ? taskNames[task.status] || '' : '尚未开始';
    return `<button class="history-item chat-item ${selectedChatId === chat.id ? 'selected' : ''}" data-chat="${escapeHTML(chat.id)}" title="${escapeHTML(chat.title)}${status ? ' · ' + escapeHTML(status) : ''}" aria-current="${selectedChatId === chat.id ? 'true' : 'false'}"><span class="chat-item-title">${escapeHTML(chat.title)}</span>${needsInput || ['running', 'queued', 'paused'].includes(task?.status) ? `<span class="chat-item-indicator ${needsInput ? 'needs-input' : task.status}" aria-label="${status}"></span>` : ''}</button>`;
  }).join('');
  $('history').scrollTop = historyScroll;
  $('chatSelect').innerHTML = sortedChats().map(chat => `<option value="${escapeHTML(chat.id)}" ${chat.id === selectedChatId ? 'selected' : ''}>${escapeHTML(chat.title)}</option>`).join('');
  $('chatTitle').textContent = currentChat()?.title || '新聊天'; $('chatTitle').title = currentChat()?.title || '新聊天';
  const chat = $('chat'); const stayBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 110;
  const messages = state.messages.filter(message => message.chatId === selectedChatId);
  chat.innerHTML = messages.length ? messages.map(message => {
    if (message.author === 'system') return `<article class="message system"><div class="system-text">${escapeHTML(message.text)}</div></article>`;
    const agent = state.agents[message.author] || (message.author === 'user' ? { name: '你', initial: '你', role: '任务发起人' } : { name: '已移除成员', initial: '旧', role: '历史记录' });
    const status = { streaming: '正在回复', interrupted: '已中断', error: '回复失败' }[message.status];
    return `<article class="message ${message.author} ${message.status}"><span class="avatar ${message.author}">${agent.initial}</span><div class="message-body"><div class="message-meta"><span class="message-name">${agent.name}</span><span class="message-role">${agent.role}</span><time class="message-time">${timeLabel(message.time)}</time></div><div class="message-content">${escapeHTML(message.text || '正在等待回复…')}${message.status === 'streaming' ? '<span class="streaming-mark" aria-hidden="true"></span>' : ''}</div>${status ? `<span class="message-status">${status}</span>` : ''}</div></article>`;
  }).join('') : `<div class="empty-room"><div class="empty-kicker">一个群聊，两位协作者</div><h2>把任务交给这个小组。</h2><p>Codex 执行，DeepSeek 分析。你可以在任意时候插话，调整接下来的方向。</p><div class="suggestions"><button class="suggestion" data-suggestion="请先一起讨论我的方案，分别提出建议，再由 Codex 汇总。">讨论一个方案</button><button class="suggestion" data-suggestion="@Codex @DeepSeek 请审查以下内容，指出具体问题和修改建议：">审查一份内容</button><button class="suggestion" data-suggestion="请规划这个项目，先由 DeepSeek 拆解需求，Codex 汇总执行步骤：">规划一个项目</button></div></div>`;
  if (lastRenderedChatId !== selectedChatId) { chat.scrollTop = drafts.get(selectedChatId)?.scrollTop ?? chat.scrollHeight; lastRenderedChatId = selectedChatId; }
  else if (stayBottom || messages.length < 2) chat.scrollTop = chat.scrollHeight;
  const task = currentTask();
  renderRunStatus(task);
  $('taskDetails').innerHTML = task ? `<h3 class="task-title">${escapeHTML(task.title)}</h3><div class="task-status">${taskNames[task.status] || task.status}</div>${task.steps.map((step, index) => `<div class="step ${step.status}"><span class="step-index">${step.status === 'complete' ? '✓' : String(index + 1).padStart(2, '0')}</span><div><div class="step-name">${state.agents[step.agent]?.name || '已移除成员'}</div><div class="step-caption">第 ${step.round} 轮 · ${stepNames[step.status]}</div></div></div>`).join('')}` : '<div class="task-empty"><p>尚未发布任务。<br>你的任务会在这里显示分工和进度。</p></div>';
  $('progressCount').textContent = task?.schedulerVersion ? `验收 ${task.acceptance.filter(item => item.status === 'passed').length} / ${task.acceptance.length}` : task ? `${task.steps.filter(step => step.status === 'complete').length} / ${task.steps.length}` : '—';
  const active = currentTask(); $('taskState').textContent = active ? taskNames[active.status] : '尚未开始';
  for (const suffix of ['', 'Mobile']) { $('pause' + suffix).disabled = !['running', 'queued'].includes(active?.status); $('resume' + suffix).disabled = active?.status !== 'paused'; $('stop' + suffix).disabled = !['running', 'queued', 'paused'].includes(active?.status); }
  $('composerLabel').textContent = ['running', 'queued', 'paused'].includes(active?.status) ? '补充要求，调整当前任务' : '发布任务或补充要求';
  $('send').textContent = ['running', 'queued', 'paused'].includes(active?.status) ? '发送补充' : '发送任务';
  const missing = Object.entries(state.connections.status).filter(([, status]) => status.state === 'unconfigured').map(([id]) => state.agents[id].name);
  const failed = Object.entries(state.connections.status).filter(([, status]) => status.state === 'error').map(([id]) => state.agents[id].name);
  const notices = [];
  if (missing.length) notices.push(`${missing.join('、')} 还未连接，请填写密钥并测试连接。`);
  if (failed.length) notices.push(`${failed.join('、')} 连接异常，请在设置中查看原因。`);
  $('notice').classList.toggle('hidden', !notices.length && !state.connections.warning);
  $('notice').innerHTML = `<span>${escapeHTML(state.connections.warning || notices.join(' '))}</span><button data-open-settings>设置连接</button>`;
  for (const id of Object.keys(state.agents)) $(`${id}Detail`).textContent = state.connections.status[id]?.detail || '等待配置';
  renderApprovals();
}
function renderApprovals() {
  for (const input of document.querySelectorAll('[data-answer]')) approvalDrafts.set(input.closest('[data-approval]').dataset.approval + ':' + input.dataset.answer, input.value);
  $('approvals').innerHTML = state.approvals.filter(item => item.chatId === selectedChatId).map(item => {
    const input = item.method === 'item/tool/requestUserInput';
    return `<section class="approval" data-approval="${item.id}"><h3>Codex ${input ? '需要你的补充' : '请求执行操作'}</h3>${input ? item.params.questions.map(question => `<label>${escapeHTML(question.question)}<input data-answer="${escapeHTML(question.id)}" value="${escapeHTML(approvalDrafts.get(item.id + ':' + question.id) || '')}" placeholder="填写你的要求">${question.options?.length ? '<small>' + question.options.map(option => escapeHTML(option.label)).join(' / ') + '</small>' : ''}</label>`).join('') : `<pre>${escapeHTML(item.params.command || item.params.reason || '请求修改任务相关文件。')}</pre>`}<div class="approval-actions">${input ? `<button class="primary-button" data-approval-answer="input">发送回答</button>` : '<button class="primary-button" data-approval-answer="accept">允许本次操作</button><button class="outline-button" data-approval-answer="decline">拒绝</button>'}</div></section>`;
  }).join('');
}
async function send() {
  if (submitting || !selectedChatId) return; const text = $('message').value.trim(); if (!text) { $('message').focus(); return; }
  submitting = true; $('send').disabled = true;
  const sendingChatId = selectedChatId;
  try { const auto = $('rounds').value === 'auto'; await api('/api/messages', { text, target: $('target').value, mode: auto ? 'auto' : 'fixed', rounds: auto ? 'auto' : Number($('rounds').value), requestId: crypto.randomUUID(), chatId: sendingChatId }); if (selectedChatId === sendingChatId) $('message').value = ''; else { const draft = drafts.get(sendingChatId); if (draft) draft.text = ''; } state = await api('/api/state'); render(); }
  catch (error) { toast(error.message); }
  finally { submitting = false; $('send').disabled = false; }
}
function openSettings() {
  if (!state) return; const config = state.connections;
  for (const key of ['workspace', 'codexPath', 'deepseekModel']) $(key).value = config[key] || '';
  $('deepseekKey').value = '';
  $('deepseekKey').placeholder = config.deepseekHasKey ? '已保存密钥；留空保持不变' : '填写 DeepSeek API Key';
  $('settingsError').textContent = ''; $('settingsDialog').showModal();
}
async function saveSettings() {
  $('saveSettings').disabled = true; $('settingsError').textContent = '';
  try { const input = Object.fromEntries(new FormData($('settingsForm'))); await api('/api/settings', input); $('deepseekKey').value = ''; toast('连接设置已加密保存在本机。'); return true; }
  catch (error) { $('settingsError').textContent = error.message; return false; }
  finally { $('saveSettings').disabled = false; }
}
$('settingsForm').addEventListener('submit', event => { event.preventDefault(); saveSettings(); });
$('closeSettings').onclick = () => $('settingsDialog').close();
for (const id of ['openSettings', 'sidebarSettings']) $(id).onclick = openSettings;
$('send').onclick = send;
$('rounds').onchange = () => $('autoHelp').classList.toggle('hidden', $('rounds').value !== 'auto');
$('closeBudget').onclick = () => $('budgetDialog').close(); $('closeBlocker').onclick = () => $('blockerDialog').close();
$('budgetForm').onsubmit = async event => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.target)); const budget = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'recoveredActiveMs').map(([key, value]) => [key, Number(value) * (key.endsWith('Ms') ? 60000 : 1)])); try { await api('/api/budget', { chatId: budgetChatId, budget, ...(fields.recoveredActiveMs !== undefined ? { recoveredActiveMs: Number(fields.recoveredActiveMs) * 60000 } : {}) }); $('budgetDialog').close(); } catch (error) { $('budgetError').textContent = error.message; } };
$('blockerForm').onsubmit = async event => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.target)); const answers = Object.fromEntries(Object.entries(fields).filter(([key]) => key.startsWith('answer:')).map(([key, value]) => [key.slice(7), value])); try { if (Object.keys(answers).length) await api('/api/blockers', { chatId: blockerChatId, answers }); for (const [key, value] of Object.entries(fields).filter(([key]) => key.startsWith('resolve:'))) await api('/api/blockers', { chatId: blockerChatId, actionKey: key.slice(8), resolution: value, basis: fields['basis:' + key.slice(8)] }); $('blockerDialog').close(); } catch (error) { $('blockerError').textContent = error.message; } };
$('refreshAccounts').onclick = async () => {
  if (refreshingAccounts) return; refreshingAccounts = true; renderAccounts();
  try { const accounts = await api('/api/accounts/refresh', {}); state.accounts = accounts; }
  catch (error) { toast(error.message); }
  finally { refreshingAccounts = false; renderAccounts(); }
};
$('message').addEventListener('keydown', event => { if (event.isComposing) return; if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); } });
for (const id of ['newChat', 'newChatMobile']) $(id).onclick = createChat;
$('chatSelect').onchange = () => selectChat($('chatSelect').value);
for (const action of ['pause', 'resume', 'stop']) for (const suffix of ['', 'Mobile']) $(action + suffix).onclick = async () => { try { await api('/api/control', { action, chatId: selectedChatId, epoch: currentChat()?.scheduler?.epoch }); } catch (error) { toast(error.message); } };
document.addEventListener('click', async event => {
  if (event.target.closest('[data-budget]')) openBudget();
  if (event.target.closest('[data-blockers]')) openBlockers();
  const member = event.target.closest('[data-member]'); if (member) { $('target').value = member.dataset.member; $('message').focus(); }
  const history = event.target.closest('[data-chat]'); if (history) selectChat(history.dataset.chat);
  const suggestion = event.target.closest('[data-suggestion]'); if (suggestion) { $('message').value = suggestion.dataset.suggestion; $('message').focus(); }
  if (event.target.closest('[data-open-settings]')) openSettings();
  const test = event.target.closest('[data-test]');
  if (test) { test.disabled = true; try { if (await saveSettings()) { const response = await api(`/api/connections/${test.dataset.test}/test`, {}); toast(response.detail); } } catch (error) { $('settingsError').textContent = error.message; } finally { test.disabled = false; } }
  const answerButton = event.target.closest('[data-approval-answer]');
  if (answerButton) { const section = answerButton.closest('[data-approval]'); let answer = answerButton.dataset.approvalAnswer; if (answer === 'input') answer = Object.fromEntries([...section.querySelectorAll('[data-answer]')].map(input => [input.dataset.answer, input.value])); try { await api(`/api/approvals/${section.dataset.approval}`, { answer }); } catch (error) { toast(error.message); } }
});
try {
  state = await api('/api/state'); render();
  source = new EventSource('/api/events'); source.addEventListener('state', event => { state = JSON.parse(event.data); render(); });
  source.onopen = () => $('syncStatus').textContent = '实时同步中';
  source.onerror = () => $('syncStatus').textContent = '连接中断，正在重连';
} catch (error) { $('chat').innerHTML = `<div class="loading-state">${escapeHTML(error.message)}<br>请刷新页面重试。</div>`; $('syncStatus').textContent = '未连接'; }
window.addEventListener('pagehide', () => source?.close());
const countdownTimer = setInterval(updateCountdowns, 30000);
window.addEventListener('pagehide', () => clearInterval(countdownTimer));
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const tool = { name: 'post_room_message', title: '发布群聊任务', description: 'Publish a user task or requirement to the currently selected local chat. Starts real model calls when connections are configured.', annotations: { readOnlyHint: false, untrustedContentHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 16000 }, target: { type: 'string', enum: ['all', 'codex_deepseek', 'codex', 'deepseek'] } }, required: ['text'], additionalProperties: false }, execute: async input => { if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000 || Object.keys(input).some(key => !['text', 'target'].includes(key))) throw new Error('任务格式不正确。'); const result = await api('/api/messages', { text: input.text, target: input.target || 'all', rounds: 1, chatId: selectedChatId }); state = await api('/api/state'); render(); return result; } };
  try { Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => toast('浏览器的智能体操作入口暂时不可用，仍可直接使用聊天室。')); } catch {}
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
