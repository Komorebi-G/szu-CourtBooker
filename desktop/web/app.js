import { installMenus, planExperience, pendingExecutionRequests, visiblePlans, repeatPlan, friendlyDate, selectionSummary } from '/experience.js';
installMenus();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const activeStates = ['scheduled', 'queued', 'preparing', 'checking', 'waiting', 'booking', 'stopping'];
const labels = { scheduled: '旧版定时', queued: '启动中', preparing: '准备中', checking: '检查中', waiting: '等待开始', booking: '预约中',
  stopping: '正在停止', stopped: '已停止', success: '已完成', partial: '部分成功', error: '执行失败',
  missed: '已错过', limited: '上限已达 · 未预约', expired: '时段已过期', no_result: '未约到', interrupted: '意外中断', corrupt: '记录损坏', draft: '已保存 · 未启动' };
const model = { accounts: [], config: null, jobs: [], session: null, date: '', editing: null, token: 0,
  times: [], options: [], courts: [], order: [], courtLabels: {}, filter: 'recent', query: '', accountFilter: '', pending: null, logTask: null, busy: false };
const jobDetails = new Map(), logRequests = new Map();
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const format = (epoch) => new Date(epoch).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
const releaseAt = (date) => Date.parse(`${addDays(date, -1)}T12:30:00+08:00`);
const goalLabels = { one: '任选一段', consecutive: '连续两段', two: '任意两段' };
const schoolUrl = 'https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/index.do#/myBooking';
const project = (id) => model.config.projects.find((item) => item.id === id);
const taskJobs = (id) => model.jobs.filter((job) => job.taskId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const taskById = (id) => model.config.tasks.find((task) => task.id === id);

function matchesPlan(job, task) {
  const previous = job.target;
  if (!previous) return true;
  if (task.revision) return task.revision === previous.revision;
  return (previous.date ?? task.date) === task.date
    && (previous.accountId ?? 'default') === (task.accountId ?? 'default')
    && JSON.stringify(previous.times) === JSON.stringify(task.times)
    && JSON.stringify(previous.courts ?? ['*']) === JSON.stringify(task.courts)
    && (previous.bookingGoal ?? (new Set(previous.times).size === 1 ? 'one' : 'two')) === (task.bookingGoal ?? (new Set(task.times).size === 1 ? 'one' : 'two'))
    && Boolean(previous.preferSameCourt) === Boolean(task.preferSameCourt)
    && Boolean(previous.includeOtherCourts) === Boolean(task.includeOtherCourts);
}
function relatedHistory(task) {
  const identity = model.accounts.find((a) => a.id === (task.accountId ?? 'default'))?.userId;
  return model.jobs.filter((j) => j.mode !== 'check'
    && (identity && j.accountIdentityId ? j.accountIdentityId === identity : (j.accountId ?? 'default') === (task.accountId ?? 'default'))
    && (!j.target || (j.target.project ?? j.target.projectId ?? model.config.projects.find((p) => p.label === j.target.sport)?.id ?? task.projectId) === task.projectId)
    && [...(j.successes ?? []), ...Object.values(j.pendingRequests ?? {})].some((r) => r.date === task.date && task.times.includes(r.time)));
}
function updateCountdowns() {
  for (const el of $$('[data-countdown]')) {
    const seconds = Math.max(0, Math.ceil((Number(el.dataset.countdown) - Date.now()) / 1000));
    el.textContent = `距离放号 ${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}${model.connected === false ? ' · 本地估算，状态尚未同步' : ''}`;
  }
}
async function cancelPendingStart() {
  if (!model.startToken) return;
  const token = model.startToken; model.startToken = null;
  try { await api('/api/starts/cancel', 'POST', { token }); toast('已取消启动，方案保留'); }
  catch (error) { toast('取消未得到确认，请重新连接并检查执行状态：' + error.message); }
}

async function api(path, method = 'GET', body, { timeoutMs = method === 'GET' ? 8000 : 60000, signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(path, { method, signal: controller.signal, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || '请求失败');
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 3500);
}
const accountLabel = (id) => {
  const account = model.accounts.find((a) => a.id === (id || 'default'));
  return account ? account.name + (account.user ? ' · ' + account.user : '') : '我的账号';
};
function renderSession() {
  $('#sessionButton').textContent = '账号管理' + (model.accounts.length > 1 ? ` · ${model.accounts.length}` : '');
  const selected = $('#authAccount').value || 'default';
  const options = model.accounts.map((account) => '<option value="' + account.id + '">' + escape(accountLabel(account.id)) + '</option>').join('');
  $('#authAccount').innerHTML = options;
  $('#authAccount').value = model.accounts.some((a) => a.id === selected) ? selected : 'default';
  const taskSelected = $('#taskAccount').value;
  $('#taskAccount').innerHTML = options;
  if (model.accounts.some((a) => a.id === taskSelected)) $('#taskAccount').value = taskSelected;
  renderAccountSummary();
}
function renderAccountSummary() {
  const account = model.accounts.find((a) => a.id === $('#authAccount').value);
  $('#accountSummary').textContent = account?.corrupt ? account.error : !account?.exists ? '尚未导入登录状态'
    : account.verifiedAt ? '上次验证成功：' + (account.user || account.name) + ' · ' + format(Date.parse(account.verifiedAt)) + '（不代表当前仍有效）'
    : '登录已保存，等待验证身份';
  $('#exportAccountButton').disabled = !account?.exists;
  $('#copyAccountButton').disabled = !account?.exists;
  $('#showAccountButton').disabled = !account?.exists;
}
async function refreshAccounts() {
  model.accounts = (await api('/api/accounts')).accounts;
  renderSession(); renderTasks();
}
function courtText(task) {
  if (task.courts.includes('*')) return '按学校顺序尝试全部场地';
  return task.courts.map((id, i) => `${i + 1}. ${task.courtLabels[id] || (id.length > 15 ? '已保存场地（编辑查看）' : id)}`).join(' → ')
    + (task.includeOtherCourts ? ' → 其余场地（学校顺序）' : '');
}
function taskContext(task) {
  const history = taskJobs(task.id), matching = history.filter((job) => matchesPlan(job, task));
  const check = matching.find((job) => job.mode === 'check');
  const current = history.find((job) => activeStates.includes(job.status)) ?? matching.find((job) => job.mode !== 'check') ?? check;
  return { plan: task, history, check, current, experience: planExperience(task, { account: model.accounts.find((a) => a.id === (task.accountId ?? 'default')), run: current }) };
}
function renderTasks() {
  const corrupt = model.jobs.filter((job) => job.status === 'corrupt');
  $('#recordError').hidden = !corrupt.length;
  $('#recordError').textContent = corrupt.length ? `${corrupt.length} 条本地记录无法读取，原文件已保留。请核对学校预约；其他方案仍可查看。` : '';
  model.date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const tasks = model.config.tasks, contexts = tasks.map(taskContext);
  const signature = JSON.stringify([tasks, model.date, model.connected, model.accounts, model.jobs.map(({ id, taskId, status, error, successes, pendingRequests }) => ({ id, taskId, status, error, successes, pendingRequests })), contexts.map((c) => c.experience), model.filter, model.query, model.accountFilter]);
  if (signature === renderTasks.signature) return;
  renderTasks.signature = signature;
  const attention = contexts.filter((c) => ['attention', 'login'].includes(c.experience.phase));
  const running = model.jobs.filter((job) => activeStates.includes(job.status));
  const next = visiblePlans(contexts)[0];
  const connected = model.accounts.some((a) => a.exists);
  const setup = !tasks.length && !running.length && !attention.length;
  const firstStart = connected && contexts.some((context) => !context.experience.expired)
    && !model.jobs.some((job) => job.mode !== 'check')
    && !running.length && !attention.length;
  const ready = contexts.find((context) => context.experience.canStart);
  $('#workspace').hidden = connected && !setup && !firstStart && !running.length && !attention.length;
  $('#workspace').classList.toggle('getting-started', setup || firstStart);
  $('#workspace').classList.toggle('first-start', firstStart);
  $('#setupSteps').hidden = !setup && !firstStart;
  $$('[data-setup-step]').forEach((step) => {
    const current = firstStart ? 3 : connected ? 2 : 1, number = Number(step.dataset.setupStep);
    step.classList.toggle('current', number === current); step.classList.toggle('complete', number < current);
    if (number === current) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
  });
  $('#addTaskButton').hidden = setup;
  $('#listTools').hidden = !tasks.length;
  $('#taskList').hidden = setup;
  $('#nextStepTitle').textContent = running.length ? `${running.length} 个执行正在进行` : !connected ? '先登录你的学校账号' : attention.length ? `${attention.length} 个方案需要处理` : firstStart ? '方案已保存，等你手动开始' : '建好第一个预约方案';
  $('#nextStepHint').textContent = running.length ? '倒计时和预约进度会在这里更新。保持电脑醒着、联网。' : !connected ? '在学校页面完成登录，再选运动的日期、时段和场地。'
    : firstStart ? ready ? `点击下方卡片的「${ready.experience.action}」，核对安排后确认开始。`
      : `方案会保留。${next?.experience.hint ?? '请在放号当天回来'}；到时在下方卡片手动启动。`
      : next ? next.experience.hint : '选好想运动的时段和场地。保存后，在方案卡片上手动开始。';
  const nextButton = $('#nextStepButton'); nextButton.hidden = firstStart;
  nextButton.classList.toggle('primary', setup); nextButton.classList.toggle('secondary', !setup);
  nextButton.textContent = running.length ? '查看进度' : !connected ? '登录学校账号' : attention.length ? '查看需处理方案' : '新建预约方案';
  nextButton.disabled = model.connected === false;
  nextButton.onclick = () => {
    if (running.length) { model.query = ''; model.accountFilter = ''; $('#taskSearch').value = ''; model.filter = 'active'; renderTasks(); $('#taskList').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else if (!connected) $('#authDialog').showModal();
    else if (attention.length) { model.query = ''; model.accountFilter = ''; $('#taskSearch').value = ''; model.filter = 'attention'; renderTasks(); }
    else if (!next) openTask();
    else taskPrimary(next);
  };
  const accountSelect = $('#accountFilter');
  accountSelect.innerHTML = '<option value="">所有账号</option>' + model.accounts.map((a) => `<option value="${escape(a.id)}">${escape(accountLabel(a.id))}</option>`).join('');
  accountSelect.value = model.accountFilter;
  $$('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === model.filter)));
  const shown = visiblePlans(contexts, { filter: model.filter, query: model.query, accountId: model.accountFilter });
  $('#listCount').textContent = `${shown.length} / ${tasks.length}`;
  if (!shown.length) {
    $('#taskList').innerHTML = `<div class="empty"><h3>${!tasks.length ? '暂无预约方案' : '没有符合条件的方案'}</h3><p>${!tasks.length ? '选择日期、时段和场地，保存后手动启动。' : '调整搜索或筛选，历史方案在「全部」中查看。'}</p><button class="secondary" data-empty="${!tasks.length ? 'new' : 'all'}">${!tasks.length ? '新建方案' : '查看全部方案'}</button></div>`;
    return;
  }
  const expanded = new Set($$('[data-plan-details][open]').map((el) => el.dataset.planDetails));
  $('#taskList').innerHTML = shown.map(({ plan: task, history, check, current, experience: ex }) => {
    const status = current?.status ?? 'draft';
    const stateLabel = current?.mode === 'check' && status === 'success' ? '检查通过 · 未启动' : labels[status] ?? status;
    const firstCourt = task.courtLabels[task.courts[0]] || (task.courts[0]?.length <= 15 ? task.courts[0] : '已选场地');
    const courtBrief = task.courts.includes('*') ? '全部场地' : `首选 ${firstCourt}${task.courts.length > 1 ? ` 等 ${task.courts.length} 场` : ''}`;
    let action = ex.phase === 'active' ? 'logs' : ex.phase === 'attention' ? 'review' : ex.phase === 'login' ? 'login' : ex.phase === 'done' ? 'logs' : ex.phase === 'expired' ? 'copy' : 'run';
    return `<article class="task-card phase-${ex.phase}" data-task="${escape(task.id)}"><div class="task-head"><div><div class="task-heading"><span class="project-tag">${escape(task.projectLabel)}</span><h3>${escape(task.name)}</h3></div><p class="task-date">${escape(friendlyDate(task.date))} · ${escape(accountLabel(task.accountId))}</p></div><span class="badge ${escape(status)}">${ex.phase === 'expired' ? '已过期' : escape(stateLabel)}</span></div>
      <div class="task-content"><div><div class="chips">${task.times.map((time) => `<span class="chip">${escape(time)}</span>`).join('')}</div></div><p class="plan-brief">${escape(goalLabels[task.bookingGoal ?? 'two'])} · ${escape(courtBrief)}${task.preferSameCourt ? ' · 同场优先' : ''}</p></div>
      <details class="plan-details" data-plan-details="${escape(task.id)}" ${expanded.has(task.id) ? 'open' : ''}><summary>方案详情</summary><div><p class="court-description">${escape(courtText(task))}</p><p class="timing-detail">${escape(format(ex.releaseAt))} 放号 · 每 ${task.intervalMs / 1000} 秒重试 · 最长 ${task.durationMs / 60000} 分钟</p></div></details>
      ${check && check !== current ? `<p class="same-court">最近检查：${check.status === 'success' ? '通过（未下单）' : escape(labels[check.status])}</p>` : ''}
      ${current?.error && !current.reviewedOutcome ? `<p class="task-error">${escape(current.error)}</p>` : ''}
      ${ex.pending ? ex.active ? '<p class="same-court">请求已发送，等待学校响应。</p>' : '<p class="task-error">请求结果待确认，请先核对学校“我的预约”。</p>' : ''}
      ${current?.successes?.length ? `<div class="task-results"><strong>已约到 ${current.successes.length} 段</strong>${current.successes.map((s) => `<p>✓ ${escape(s.time)} · ${escape(s.court)}${s.reused ? (s.school ? '（学校已有）' : '（本批次已约）') : ''}</p>`).join('')}<a href="${schoolUrl}" target="_blank" rel="noopener noreferrer">核对预约 / 去付款 ↗</a></div>` : ''}
      <div class="task-footer"><div>${!ex.pending ? `<p class="next-hint">${escape(ex.hint)}</p>` : ''}${ex.active && current.status === 'waiting' ? `<strong class="countdown" data-countdown="${current.releaseAt ?? ex.releaseAt}"></strong>` : ''}</div><div class="task-actions">
      ${!ex.active ? '<button class="text-button" data-action="edit">编辑</button>' : ''}
      <details class="more-actions"><summary aria-label="更多方案操作">···</summary><div>${!ex.active && ex.phase !== 'expired' ? '<button class="text-button" data-action="copy">再约一次</button>' : ''}${history.length ? '<button class="text-button" data-action="logs">执行记录</button>' : ''}${!ex.active ? `<button class="text-button" data-action="review">核对并生成剩余方案</button><button class="text-button" data-action="check" ${ex.expired || model.connected === false ? 'disabled' : ''}>检查配置</button><button class="text-button danger-text" data-action="delete">删除方案</button>` : ''}</div></details>
      ${ex.active ? `<button class="secondary" data-action="logs">查看进度</button><button class="danger" data-action="stop" ${status === 'stopping' ? 'disabled' : ''}>停止本次执行</button>` : `<button class="primary" data-action="${action}" ${ex.phase === 'future' || model.connected === false ? 'disabled' : ''}>${escape(ex.action)}</button>`}</div></div></article>`;
  }).join('');
  updateCountdowns();
}
function taskPrimary(context) {
  const { plan: task, experience: ex } = context;
  if (ex.phase === 'future') { openTask(task); return; }
  if (ex.phase === 'login') { $('#authAccount').value = task.accountId ?? 'default'; renderAccountSummary(); $('#authDialog').showModal(); return; }
  if (ex.phase === 'attention') { void reviewTask(task).catch((error) => toast(error.message)); return; }
  if (['active', 'done'].includes(ex.phase)) { model.logTask = task.id; $('#logTitle').textContent = task.name; $('#logHistory').innerHTML = ''; $('#logDialog').showModal(); renderLogs(); return; }
  if (ex.phase === 'expired') openTask(repeatPlan(task)); else confirmRun(task);
}
$('#taskSearch').oninput = () => { model.query = $('#taskSearch').value; renderTasks(); };
$('#accountFilter').onchange = () => { model.accountFilter = $('#accountFilter').value; renderTasks(); };
$$('[data-filter]').forEach((button) => button.onclick = () => { model.filter = button.dataset.filter; renderTasks(); });
$('#taskList').addEventListener('click', (event) => {
  const empty = event.target.closest('[data-empty]'); if (!empty) return;
  if (empty.dataset.empty === 'new') openTask(); else { model.filter = 'all'; model.query = ''; model.accountFilter = ''; $('#taskSearch').value = ''; renderTasks(); }
});
function renderLogs() {
  if (!$('#logDialog').open) return;
  const history = taskJobs(model.logTask);
  const selected = $('#logHistory').value;
  $('#logHistory').innerHTML = history.map((job) => `<option value="${job.id}">${escape(format(Date.parse(job.createdAt)))} · ${job.mode === 'check' ? '配置检查' : '预约'} · ${labels[job.status]}</option>`).join('');
  if (history.some((job) => job.id === selected)) $('#logHistory').value = selected;
  const summary = history.find((job) => job.id === $('#logHistory').value);
  const job = summary ? jobDetails.get(summary.id) ?? summary : null;
  if (summary && !jobDetails.has(summary.id) && !logRequests.has(summary.id)) void loadLogDetails(summary.id);
  $('#stopLogButton').hidden = !job || !activeStates.includes(job.status);
  $('#stopLogButton').disabled = job?.status === 'stopping';
  $('#deleteLogButton').disabled = !job || activeStates.includes(job.status) || pendingExecutionRequests(job).length > 0;
  $('#reviewLogButton').hidden = !job || job.mode === 'check' || activeStates.includes(job.status);
  $('#exportLogButton').disabled = !job;
  $('#logResult').innerHTML = job ? `<p>用户：${escape(job.accountName || accountLabel(job.accountId))} · 状态：${escape(labels[job.status])}${job.mode === 'check' ? '（未下单）' : ''}${job.reviewedOutcome === 'success' ? ' · 学校订单已核实完成' : ''}</p>${(job.successes ?? []).map((s) => `<p>✓ ${escape(s.date)} ${escape(s.time)} · ${escape(s.court)}${s.orderId ? ` · 订单 ${escape(s.orderId)}` : ''}</p>`).join('')}${pendingExecutionRequests(job).map((r) => `<p class="${activeStates.includes(job.status) ? "muted" : "error"}">${activeStates.includes(job.status) ? "等待响应" : "待核对"}：${escape(r.date)} ${escape(r.time)} · ${escape(r.room?.CDMC)}</p>`).join('')}${(job.slots ?? []).map((slot) => `<p>${escape(slot.time)} · ${escape({ success: '已成功', expired: '已过期', limited: '已达上限', goal_reached: '目标已达，未尝试', ineligible: '不符合连续目标，未尝试', conflict: '与本批次已约场地冲突', unfilled: '未约到', error: '发生错误' }[slot.status] ?? slot.status)}${slot.lastMessage ? ' · ' + escape(slot.lastMessage) : ''}</p>`).join('')}<a href="${schoolUrl}" target="_blank" rel="noopener noreferrer">打开学校“我的预约”核对 / 付款</a>${job.error ? `<p class="error">原执行记录：${escape(job.error)}</p>` : ''}` : '';
  const box = $('#logBox');
  const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = job?.logs?.length ? job.logs.map((entry) => `<div class="log-line ${escape(entry.level)}"><time>${escape(format(Date.parse(entry.time)))}</time>${escape(entry.message)}${entry.details?.courts ? `\n${escape(entry.details.courts.join(' → '))}` : ''}${entry.details?.durationMs !== undefined ? ` · 耗时 ${escape(entry.details.durationMs)}ms` : ''}${entry.details?.quotaQueueMs !== undefined ? ` · 名额队列等待 ${escape(entry.details.quotaQueueMs)}ms` : ''}${entry.details?.requestId ? ` · 请求 ${escape(entry.details.requestId)}` : ''}</div>`).join('') : '<p class="muted">记录已保存，执行开始后会在这里显示日志。</p>';
  if (bottom) box.scrollTop = box.scrollHeight;
}
async function loadLogDetails(id) {
  if (logRequests.has(id)) return logRequests.get(id);
  const work = (async () => {
    try {
      const data = await api(`/api/jobs/${id}`);
      jobDetails.set(id, data.job ?? model.jobs.find((job) => job.id === id));
    } catch (error) { if ($('#logDialog').open && $('#logHistory').value === id) toast('执行记录读取失败：' + error.message); }
    finally { logRequests.delete(id); }
  })();
  logRequests.set(id, work);
  await work;
  if ($('#logDialog').open && $('#logHistory').value === id && jobDetails.has(id)) renderLogs();
}
async function refreshJobs() {
  const data = await api('/api/jobs');
  if (model.notifications) for (const job of data.jobs) {
    const prior = model.jobs.find((j) => j.id === job.id);
    if (prior && activeStates.includes(prior.status) && !activeStates.includes(job.status)) {
      const message = `${job.target?.name ?? '本次执行'}：${labels[job.status]}，成功 ${job.successes?.length ?? 0} 段`;
      toast(message);
      if (window.Notification && Notification.permission === 'granted') new Notification('场馆预约结果', { body: message });
    }
  }
  model.jobs = data.jobs;
  renderTasks();
  if ($('#logDialog').open) { renderLogs(); const id = $('#logHistory').value; if (id) await loadLogDetails(id); }
  updateCountdowns();

}
async function bootstrap() {
  const data = await api('/api/bootstrap');
  model.connected = true; model.lastSynced = Date.now();
  Object.assign(model, { config: data.config, jobs: data.jobs, session: data.session, date: data.serverDate,
    accounts: data.accounts ?? [{ id: 'default', name: '我的账号', ...data.session }] });
  $('#schedulerHint').hidden = !data.legacyCleanupErrors?.length;
  $('#schedulerHint').textContent = data.legacyCleanupErrors?.join('；') ?? '';
  renderSession(); renderTasks();
  const browser = localStorage.getItem('szu-auth-browser');
  if (['edge', 'chrome', 'brave', 'chromium'].includes(browser)) $('#authBrowser').value = browser;
  if (['running', 'cancelling', 'verifying', 'binding', 'awaiting_identity'].includes(data.auth?.status)) pollAuth();
}
function closeTask() { model.token++; model.catalogController?.abort(); $('#taskDialog').close(); }
$$('[data-close]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.close === 'confirm') void cancelPendingStart();
  if (button.dataset.close === 'task') closeTask(); else $(`#${button.dataset.close}Dialog`).close();
}));
$('#taskDialog').addEventListener('close', () => { model.token++; model.catalogController?.abort(); });
$('#confirmDialog').addEventListener('cancel', () => { void cancelPendingStart(); });
function schedulePreview() {
  const at = releaseAt($('#taskDate').value);
  $('#saveTaskButton').hidden = new Date(at + 8 * 3600_000).toISOString().slice(0, 10) > model.date;
  $('#saveTaskButton').textContent = '保存并启动';
  $('#schedulePreview').textContent = `学校放号：${format(at)}。${at <= Date.now() ? '已放号，开始本次执行后立即尝试。' : '请在放号当天登录，再开始本次倒计时。'}`;

}
function updateSelectionSummary() {
  $('#bookingGoalHint').hidden = $('#bookingGoal').value !== 'consecutive';
  const summary = selectionSummary(model.times, model.order, $('#bookingGoal').value);
  $('#selectionSummary').textContent = summary.text; $('#selectionSummary').classList.toggle('complete', summary.valid);
}
$('#bookingGoal').addEventListener('change', updateSelectionSummary);
function renderTimes() {
  updateSelectionSummary();
  $('#timeOptions').innerHTML = model.options.map((time) => `<button type="button" class="time-option ${model.times.includes(time) ? 'selected' : ''}" data-time="${escape(time)}" aria-pressed="${model.times.includes(time)}">${escape(time)}</button>`).join('');
}
function renderCourts() {
  updateSelectionSummary();
  const all = model.order.includes('*');
  $('#allCourts').setAttribute('aria-pressed', String(all));
  $('#courtSequence').innerHTML = all ? '全部场地 · 按学校返回的顺序尝试' : model.order.length
    ? model.order.map((id, i) => `<span class="order-chip"><b>${i + 1}</b>${escape(model.courtLabels[id] || id)}<button type="button" data-move="${i}" data-step="-1" aria-label="上移 ${escape(model.courtLabels[id] || id)}" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move="${i}" data-step="1" aria-label="下移 ${escape(model.courtLabels[id] || id)}" ${i === model.order.length - 1 ? 'disabled' : ''}>↓</button></span>`).join('<span aria-hidden="true">→</span>')
    : '<span class="muted">尚未选择场地</span>';
  $('#courtList').innerHTML = model.courts.map((court) => {
    const index = all ? -1 : model.order.indexOf(court.id);
    return `<button type="button" class="court-card ${index >= 0 ? 'selected' : ''}" data-court="${escape(court.id)}" aria-pressed="${index >= 0}" aria-label="${escape(court.name)}${index >= 0 ? `，第 ${index + 1} 优先` : ''}"><span class="court-order">${index >= 0 ? index + 1 : '+'}</span><span class="court-name">${escape(court.name)}<span class="court-venue">${escape(court.venue)}</span></span></button>`;
  }).join('');
}
async function loadProject(task) {
  const token = ++model.token;
  model.catalogController?.abort(); model.catalogController = new AbortController();
  const id = $('#taskProject').value;
  model.times = [...(task?.times ?? [])]; model.options = [...model.times];
  model.order = [...(task?.courts ?? ['*'])]; model.courts = [];
  model.courtLabels = { ...(task?.courtLabels ?? {}) };
  $('#preferSameCourt').checked = task?.preferSameCourt ?? id === 'volleyball';
  $('#includeOtherCourts').checked = task?.includeOtherCourts ?? false;
  renderTimes(); renderCourts();
  $('#timeNote').textContent = '正在读取学校时段目录……';
  $('#courtList').innerHTML = '<span class="muted">正在读取场地……</span>';
  $('#courtNote').textContent = '';
  const query = `accountId=${encodeURIComponent($('#taskAccount').value)}&date=${encodeURIComponent($('#taskDate').value)}`;
  const result = await api(`/api/projects/${id}/catalog?${query}`, 'GET', undefined, { timeoutMs: 60000, signal: model.catalogController.signal })
    .then((value) => ({ value })).catch((error) => ({ error }));
  if (token !== model.token || !$('#taskDialog').open) return;
  const catalog = result.value;
  const source = catalog ? (catalog.dates?.length ? catalog.dates.join('、') : catalog.date) : '';
  const note = catalog ? `参考 ${source}${catalog.cached ? '，含此前读到的目录' : ''}；不代表目标日期可订。`
    + (catalog.partial ? ' 部分目录暂未读到，可重新读取补充。' : '') : '';
  if (catalog) {
    model.options = [...new Set([...catalog.times.map((t) => t.value), ...model.times])].sort();
    $('#timeNote').textContent = note;
  } else $('#timeNote').textContent = `时段读取失败：${result.error.message}。可重试或手动填写真实时段。`;
  renderTimes();
  if (catalog) {
    model.courts = catalog.courts;
    $('#courtNote').textContent = '';
    for (const court of model.courts) {
      // Older preferences may contain names rather than IDs.
      model.order = model.order.map((value) => value === court.name ? court.id : value);
      model.courtLabels[court.id] = court.name;
    }
    renderCourts();
    if (!model.courts.length) $('#courtList').innerHTML = '<p class="muted">暂无场地目录，可点击上方刷新。</p>';
  } else {
    $('#courtList').innerHTML = `<p class="muted">场地读取失败：${escape(result.error.message)}。已保存的选择仍保留。</p>`;
    $('#courtNote').textContent = '';
  }
}
function openTask(task = null) {
  if (model.busy) return toast('正在保存，请稍候');
  model.editing = task?.id ?? null;
  $('#taskForm').reset(); $('#taskError').textContent = '';
  $('#taskAccount').value = task?.accountId ?? model.accounts.find((a) => a.exists)?.id ?? model.accounts[0]?.id ?? 'default';
  $('#taskDialogTitle').textContent = task ? task.id ? '编辑方案' : '再约一次 · 确认新日期' : '新建方案';
  $('#taskProject').innerHTML = model.config.projects.map((p) => `<option value="${p.id}">${escape(p.label)}</option>`).join('');
  $('#taskProject').value = task?.projectId || model.config.projects[0].id;
  $('#taskDate').innerHTML = Array.from({ length: 8 }, (_, i) => {
    const day = addDays(model.date, i); return `<option value="${day}">${day}${i === 0 ? ' · 今天' : i === 1 ? ' · 明天' : ''}</option>`;
  }).join('');
  if (task && (task.date < model.date || task.date > addDays(model.date, 7))) $('#taskDate').insertAdjacentHTML('afterbegin', `<option value="${escape(task.date)}">${escape(task.date)} · 已过期，请主动选择新日期</option>`);
  $('#taskDate').value = task?.date ?? addDays(model.date, 1);
  $('#bookingGoal').value = task?.bookingGoal ?? 'two';
  $('#taskName').value = task?.name ?? '';
  $('#taskInterval').value = (task?.intervalMs ?? 100) / 1000;
  $('#taskDuration').value = (task?.durationMs ?? 60_000) / 60_000;
  schedulePreview(); $('#taskDialog').showModal(); $('#taskDialog').scrollTop = 0;
  void loadProject(task);
}
$('#addTaskButton').addEventListener('click', () => { if (!model.config) return toast('请先连接管理服务'); openTask(); });
$('#refreshCatalog').onclick = () => { void loadProject({ times: model.times, courts: model.order, courtLabels: model.courtLabels, preferSameCourt: $('#preferSameCourt').checked, includeOtherCourts: $('#includeOtherCourts').checked }); };
$('#courtSequence').onclick = (event) => { const button = event.target.closest('[data-move]'); if (!button || button.disabled) return; const i = Number(button.dataset.move), next = i + Number(button.dataset.step); [model.order[i], model.order[next]] = [model.order[next], model.order[i]]; renderCourts(); };
$$('[data-preset]').forEach((b) => b.onclick = () => { $('#taskInterval').value = b.dataset.preset === 'release' ? '0.1' : '30'; $('#taskDuration').value = b.dataset.preset === 'release' ? '2' : '120'; });
$('#taskProject').addEventListener('change', () => { $('#taskError').textContent = ''; void loadProject(); });
$('#taskDate').addEventListener('change', () => { schedulePreview(); void loadProject({ times: model.times, courts: model.order, courtLabels: model.courtLabels, preferSameCourt: $('#preferSameCourt').checked, includeOtherCourts: $('#includeOtherCourts').checked }); });
$('#timeOptions').addEventListener('click', (event) => {
  const time = event.target.closest('[data-time]')?.dataset.time;
  if (!time) return;
  model.times = model.times.includes(time) ? model.times.filter((t) => t !== time) : [...model.times, time].sort(); renderTimes();
});
$('#addTimeButton').addEventListener('click', () => {
  const start = $('#manualStart').value, end = $('#manualEnd').value;
  if (!start || !end || start >= end) { $('#taskError').textContent = '请填写有效时段，结束时间须晚于开始时间'; return; }
  const time = `${start}-${end}`; model.options = [...new Set([...model.options, time])].sort();
  model.times = [...new Set([...model.times, time])].sort(); renderTimes(); $('#taskError').textContent = '';
});
$('#courtList').addEventListener('click', (event) => {
  const id = event.target.closest('[data-court]')?.dataset.court;
  if (!id) return;
  if (model.order.includes('*')) model.order = [];
  model.order = model.order.includes(id) ? model.order.filter((value) => value !== id) : [...model.order, id]; renderCourts();
});
$('#allCourts').addEventListener('click', () => { model.order = ['*']; renderCourts(); });
$('#clearCourts').addEventListener('click', () => { model.order = []; renderCourts(); });
$('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault(); if (model.busy) return;
  if (!model.times.length || !model.order.length) { $('#taskError').textContent = '至少选择一个时段和一个场地，或选择尝试全部场地'; return; }
  const summary = selectionSummary(model.times, model.order, $('#bookingGoal').value);
  if (!summary.valid) { $('#taskError').textContent = summary.text; return; }
  const intent = event.submitter?.value ?? 'draft';
  const body = { accountId: $('#taskAccount').value, projectId: $('#taskProject').value, name: $('#taskName').value,
    date: $('#taskDate').value, bookingGoal: $('#bookingGoal').value, times: model.times, courts: model.order, courtLabels: model.courtLabels,
    preferSameCourt: $('#preferSameCourt').checked, includeOtherCourts: $('#includeOtherCourts').checked, enabled: true,
    intervalMs: Number($('#taskInterval').value) * 1000, durationMs: Number($('#taskDuration').value) * 60_000 };
  model.busy = true;
  $$('#taskForm button[type="submit"]').forEach((b) => { b.disabled = true; });
  try {
    const data = await api(model.editing === null ? '/api/tasks' : `/api/tasks/${model.editing}`, model.editing === null ? 'POST' : 'PUT', body);
    model.config = data.config; renderTasks(); closeTask();
    if (intent === 'start') confirmRun(taskById(data.taskId)); else toast('方案已保存，在卡片上手动开始预约');
  } catch (error) { $('#taskError').textContent = error.message; }
  finally { model.busy = false; $$('#taskForm button[type="submit"]').forEach((b) => { b.disabled = false; }); }
});
function confirmRun(task) {
  if (model.connected === false) return toast('请先恢复连接');
  if (!model.accounts.find((a) => a.id === (task.accountId ?? 'default'))?.exists) { $('#authAccount').value = task.accountId ?? 'default'; renderAccountSummary(); $('#authDialog').showModal(); return toast('请先登录此用户，再开始预约'); }
  const at = releaseAt(task.date);
  const mode = at > Date.now() ? 'release' : 'now';
  model.pending = { taskId: task.id, mode };
  $('#confirmTitle').textContent = mode === 'now' ? '立即尝试预约？' : '开始本次倒计时？';
  $('#confirmSummary').textContent = `${task.name} · ${task.date}\n用户：${accountLabel(task.accountId)}\n${task.times.join('、')} · ${goalLabels[task.bookingGoal ?? 'two']}\n${mode === 'now' ? '验证登录后立即尝试预约。' : `验证登录后等待 ${format(at)} 放号。请保持助手运行。`}\n每 ${task.intervalMs / 1000} 秒重试，最长 ${task.durationMs / 60_000} 分钟。`;
  if (relatedHistory(task).length) {
    $('#confirmSummary').textContent += '\n\n此账号、项目、日期和时段有成功或待核对记录（可能来自其他方案）。请先使用“核对并生成剩余方案”。';
  }
  $('#confirmSummary').style.whiteSpace = 'pre-line';
  $('#confirmError').textContent = '';
  const tooEarly = mode === 'release' && new Date(at + 8 * 3600_000).toISOString().slice(0, 10) !== model.date;
  $('#confirmRunButton').disabled = tooEarly;
  $('#confirmRunButton').textContent = mode === 'now' ? '验证登录并立即尝试' : '验证登录并开始倒计时';
  $('#confirmLoginButton').hidden = true;
  if (tooEarly) $('#confirmError').textContent = '方案已保存。请在放号当天登录并启动，无需提前守候。';
  $('#confirmDialog').showModal();
}
$('#confirmRunButton').addEventListener('click', async () => {
  const button = $('#confirmRunButton'); button.disabled = true;
  const token = crypto.randomUUID(); model.startToken = token;
  try {
    const data = await api(`/api/tasks/${model.pending.taskId}/run`, 'POST', { mode: 'auto', confirm: 'SUBMIT', startToken: token });
    if (model.startToken !== token) { await api('/api/starts/cancel', 'POST', { token }); await refreshJobs(); return; }
    model.startToken = null; model.config = data.config; $('#confirmDialog').close(); await refreshJobs(); toast('本次执行已开始，请保持助手运行');
  } catch (error) {
    if (model.startToken !== token) return;
    await api('/api/starts/cancel', 'POST', { token }).catch(() => { toast('取消启动未得到确认，请检查执行状态'); });
    const needsLogin = /登录|认证|Cookie|学校身份/.test(error.message);
    $('#confirmError').textContent = `${error.message}。方案仍保留。${needsLogin ? '请更新登录后重新启动。' : ''}`;
    $('#confirmLoginButton').hidden = !needsLogin;
    // Refresh account status and identifiers after an unsuccessful start.
    await bootstrap().catch(() => {});
  }
  finally { if (model.startToken === token) model.startToken = null; if (!model.startToken) button.disabled = false; }
});
$('#confirmLoginButton').addEventListener('click', () => {
  const task = taskById(model.pending.taskId);
  $('#confirmDialog').close(); $('#authAccount').value = task.accountId || 'default';
  renderAccountSummary(); $('#authDialog').showModal();
});
$('#taskList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]'), row = button?.closest('[data-task]');
  if (!row || button.disabled) return;
  const task = taskById(row.dataset.task), action = button.dataset.action;
  button.disabled = true;
  try {
    if (action === 'review') await reviewTask(task);
    if (action === 'edit') openTask(task);
    if (action === 'copy') openTask(repeatPlan(task));
    if (action === 'login') taskPrimary(taskContext(task));
    if (action === 'run') confirmRun(task);
    button.closest('.more-actions')?.removeAttribute('open');
    if (action === 'logs') {
      model.logTask = task.id; $('#logTitle').textContent = task.name; $('#logHistory').innerHTML = ''; $('#logDialog').showModal(); renderLogs();
    }
    if (action === 'check') {
      const data = await api(`/api/tasks/${task.id}/run`, 'POST', { mode: 'check' });
      model.config = data.config; await refreshJobs(); toast('开始检查配置，不会下单');
    }
    if (action === 'stop') {
      const job = taskJobs(task.id).find((job) => activeStates.includes(job.status));
      if (job) await api(`/api/jobs/${job.id}/stop`, 'POST', {});
      await refreshJobs(); toast('已请求停止，等待在途请求结束');
    }
    if (action === 'delete' && confirm(`删除方案“${task.name}”及本地日志？日志将移入本地回收目录；学校预约不会取消。`)) {
      const data = await api(`/api/tasks/${task.id}`, 'DELETE'); model.config = data.config;
      await refreshJobs(); toast('方案已删除，日志已移入本地回收目录');
    }
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#logHistory').addEventListener('change', renderLogs);
$('#exportLogButton').addEventListener('click', async () => {
  try {
    const id = $('#logHistory').value;
    const data = await api(`/api/jobs/${id}/diagnostics`);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    link.download = `szu-diagnostics-${id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) { toast(error.message); }
});
$('#stopLogButton').addEventListener('click', async () => {
  try { await api(`/api/jobs/${$('#logHistory').value}/stop`, 'POST', {}); await refreshJobs(); }
  catch (error) { toast(error.message); }
});
$('#deleteLogButton').addEventListener('click', async () => {
  if (!confirm('把这次执行日志移入本地回收目录？旧版定时项也会清理。')) return;
  try { await api(`/api/jobs/${$('#logHistory').value}`, 'DELETE'); await refreshJobs(); }
  catch (error) { toast(error.message); }
});
$('#reviewLogButton').addEventListener('click', async () => {
  const task = taskById(model.logTask), jobId = $('#logHistory').value;
  try { await reviewTask(task, { jobId }); renderLogs(); }
  catch (error) { toast(error.message); }
});
$('#sessionButton').addEventListener('click', () => { $('#authDialog').showModal(); });
async function authAction(button, action) {
  button.disabled = true;
  $('#authProgress').classList.remove('error');
  try { await action(); } catch (error) { $('#authProgress').textContent = error.message; $('#authProgress').classList.add('error'); }
  finally { button.disabled = false; }
}

$('#authAccount').addEventListener('change', () => { renderAccountSummary(); $('#authProgress').textContent = ''; $('#authProgress').classList.remove('error'); $('#curlInput').value = ''; $('#loginJsonExport').value = ''; $('#loginJsonExport').hidden = true; });
$('#authBrowser').addEventListener('change', () => localStorage.setItem('szu-auth-browser', $('#authBrowser').value));
$('#taskAccount').addEventListener('change', () => {
  void loadProject({ times: model.times, courts: model.order, courtLabels: model.courtLabels,
    preferSameCourt: $('#preferSameCourt').checked, includeOtherCourts: $('#includeOtherCourts').checked });
});
$('#addAccountButton').addEventListener('click', (event) => authAction(event.currentTarget, async () => {
  const data = await api('/api/accounts', 'POST', { name: $('#accountName').value });
  model.accounts = data.accounts; renderSession(); $('#authAccount').value = data.account.id;
  renderAccountSummary(); $('#accountName').value = ''; $('#authProgress').textContent = '用户已添加，请导入登录状态';
}));
async function pollAuth() {
  clearTimeout(pollAuth.timer);
  try {
    const data = await api('/api/auth/status');
    model.accounts = data.accounts; renderSession();
    const active = ['running', 'cancelling', 'verifying', 'binding', 'awaiting_identity'].includes(data.auth.status);
    $('#startAuthButton').disabled = active;
    $('#authAccount').disabled = active;
    $('#authBrowser').disabled = active;
    $('#cancelAuthButton').hidden = !['running', 'cancelling', 'binding', 'awaiting_identity'].includes(data.auth.status);
    $('#bindIdentityButton').hidden = data.auth.status !== 'awaiting_identity';
    $('#cancelAuthButton').disabled = data.auth.status === 'cancelling';
    $('#authProgress').textContent = data.auth.logs.slice(-5).map((line) => line.message).join('\n');
    if (active && data.auth.status !== 'awaiting_identity') pollAuth.timer = setTimeout(pollAuth, 1000);
    else await refreshAccounts();
  } catch (error) { $('#authProgress').textContent = error.message; }
}
$('#bindIdentityButton').onclick = async () => { const button = $('#bindIdentityButton'); button.disabled = true; try { await api('/api/auth/bind', 'POST', {}); await pollAuth(); } catch (error) { $('#authProgress').textContent = error.message; await pollAuth(); } finally { button.disabled = false; } };
$('#startAuthButton').addEventListener('click', async () => {
  $('#startAuthButton').disabled = true;
  $('#authProgress').classList.remove('error');
  $('#authProgress').textContent = '正在打开浏览器……';
  try {
    await api('/api/auth/start', 'POST', { accountId: $('#authAccount').value, browser: $('#authBrowser').value });
    await pollAuth();
  } catch (error) { $('#authProgress').textContent = error.message; $('#startAuthButton').disabled = false; }
});
$('#cancelAuthButton').addEventListener('click', async () => {
  $('#cancelAuthButton').disabled = true;
  try { await api('/api/auth/cancel', 'POST', {}); await pollAuth(); }
  catch (error) { $('#authProgress').textContent = error.message; $('#cancelAuthButton').disabled = false; }
});
$('#importCurlButton').addEventListener('click', (event) => authAction(event.currentTarget, async () => {
  const data = await api('/api/accounts/' + $('#authAccount').value + '/import', 'POST', { text: $('#curlInput').value });
  $('#curlInput').value = ''; $('#loginFile').value = ''; model.accounts = data.accounts; renderSession();
  $('#authProgress').textContent = '登录已导入此用户，请点击验证检查学校身份';
}));
$('#loginFile').addEventListener('change', async () => {
  const file = $('#loginFile').files[0];
  if (!file) return;
  if (file.size > 2_000_000) { $('#authProgress').textContent = '文件过大'; return; }
  $('#curlInput').value = await file.text();
});
$('#verifySessionButton').addEventListener('click', (event) => authAction(event.currentTarget, async () => {
  $('#authProgress').textContent = '正在验证登录，请稍候……';
  $('#authProgress').scrollIntoView({ block: 'center', behavior: 'smooth' });
  const data = await api('/api/accounts/' + $('#authAccount').value + '/verify', 'POST', {});
  model.accounts = data.accounts; renderSession(); $('#authProgress').textContent = '验证成功：' + data.account.user;
  $('#authProgress').scrollIntoView({ block: 'center', behavior: 'smooth' });
}));
$('#deleteSessionButton').addEventListener('click', (event) => authAction(event.currentTarget, async () => {
  if (!confirm('清除此用户的登录？下次执行前需要重新登录。')) return;
  const data = await api('/api/accounts/' + $('#authAccount').value + '/session', 'DELETE');
  model.accounts = data.accounts; renderSession(); $('#authProgress').textContent = '此用户登录已清除';
}));
async function exportLogin() {
  return JSON.stringify(await api('/api/accounts/' + $('#authAccount').value + '/export', 'POST', {}), null, 2);
}
$('#exportAccountButton').addEventListener('click', (event) => authAction(event.currentTarget, async () => {
  const text = await exportLogin();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = 'szu-login-' + $('#authAccount').value + '.json';
  link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  $('#authProgress').textContent = '登录文件已导出，舍友可在账号管理中导入';
}));
$('#copyAccountButton').addEventListener('click', (event) => authAction(event.currentTarget, async () => {
  await navigator.clipboard.writeText(await exportLogin());
  $('#authProgress').textContent = '登录 JSON 已复制';
}));
$('#showAccountButton').addEventListener('click', (event) => authAction(event.currentTarget, async () => {
  $('#loginJsonExport').value = await exportLogin(); $('#loginJsonExport').hidden = false;
  $('#loginJsonExport').scrollIntoView({ block: 'center' });
}));
$('#quitAppButton').addEventListener('click', async () => {
  if (!confirm('停止本次全部执行并退出助手？会等待已发出的请求返回，已成功预约保留。')) return;
  try { await api('/api/app/quit', 'POST', {}); model.quitting = true; toast('执行已停止，助手已退出，可以关闭网页'); }
  catch (error) { toast(error.message); }
});

model.notifications = localStorage.getItem('szu-result-notifications') === '1';
if (model.notifications) $('#notificationButton').textContent = '关闭结果提醒';
async function reviewTask(task, { jobId } = {}) {
  const taskId = task.id;
  const checked = await api(`/api/tasks/${taskId}/review${jobId ? '?jobId=' + encodeURIComponent(jobId) : ''}`), { review } = checked;
  task = checked.plan ?? task;
  if (checked.jobs) { model.jobs = checked.jobs; jobDetails.clear(); renderTasks(); }
  const details = review.booked.map((s) => `已约：${s.time} ${s.court}`).join('\n');
  const unresolved = review.unresolved.map((s) => `${s.time ?? '未识别时段'}：${s.reason}`).join('\n');
  if (unresolved && !confirm(`${unresolved}\n\n请先在学校“我的预约”人工核对。是否已确认剩余时段没有订单或在途请求？`)) return;
  if (unresolved && review.reviewToken) {
    const acknowledged = await api(`/api/tasks/${taskId}/review`, 'POST', { reviewToken: review.reviewToken, confirm: 'NO_PENDING_ORDER' });
    model.jobs = acknowledged.jobs; jobDetails.clear(); renderTasks();
  }
  if (!review.remainingTimes.length) return toast([review.reason, details].filter(Boolean).join('；') || '无需生成剩余方案');
  if (!confirm(`${details}\n剩余：${review.remainingTimes.join('、')}\n生成一份新的剩余方案？保存后不会自动执行。`)) return;
  const data = await api('/api/tasks', 'POST', { ...task, projectId: task.projectId,
    name: `${task.name} · 剩余`, times: review.remainingTimes, bookingGoal: review.remainingGoal, sameCourtAnchor: review.sameCourtAnchor });
  model.config = data.config; renderTasks(); toast('剩余方案已保存，原方案和结果保留');
}
$('#notificationButton').onclick = async () => {
  model.notifications = !model.notifications;
  localStorage.setItem('szu-result-notifications', model.notifications ? '1' : '0');
  $('#notificationButton').textContent = model.notifications ? '关闭结果提醒' : '开启结果提醒';
  if (!model.notifications) return toast('已关闭结果提醒');
  if (window.Notification && Notification.permission === 'default') await Notification.requestPermission();
  toast(window.Notification && Notification.permission === 'granted' ? '已开启执行结果通知' : '已开启页面内结果提醒，请保持页面打开');
};
let polling = false;
async function poll() {
  if (model.quitting || polling) return;
  polling = true;
  try {
    if (!model.config || model.connected === false) await bootstrap(); else await refreshJobs();
    model.connected = true; model.lastSynced = Date.now();
    $('#connectionError').hidden = true; $('#reconnectButton').hidden = true;
    renderTasks();
  } catch (error) {
    model.connected = false;
    $('#connectionError').hidden = false; $('#reconnectButton').hidden = false;
    $('#connectionError').textContent = `暂时无法连接管理服务：${error.message}。${model.lastSynced ? '最后同步 ' + format(model.lastSynced) + '；显示的是缓存状态。' : '正在自动重试连接。'}倒计时仍为本地估算；恢复后请检查执行与学校预约。`;
    if (model.config) renderTasks();
  } finally { polling = false; }
  clearTimeout(poll.timer); poll.timer = setTimeout(poll, 1500);
}
$('#reconnectButton').onclick = () => { clearTimeout(poll.timer); void poll(); };
setInterval(updateCountdowns, 1000);
void poll();
