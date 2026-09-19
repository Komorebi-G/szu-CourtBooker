const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const activeStates = ['scheduled', 'preparing', 'checking', 'waiting', 'booking', 'stopping'];
const labels = { scheduled: '已安排', preparing: '准备中', checking: '检查中', waiting: '等待开始', booking: '预约中',
  stopping: '正在停止', stopped: '已停止', success: '已完成', partial: '部分成功', error: '执行失败',
  missed: '已错过', interrupted: '意外中断', draft: '未安排' };
const model = { accounts: [], config: null, jobs: [], session: null, date: '', editing: null, token: 0,
  times: [], options: [], courts: [], order: [], courtLabels: {}, pending: null, logTask: null, busy: false };
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const format = (epoch) => new Date(epoch).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const localInput = (epoch) => new Date(epoch + 8 * 3600_000).toISOString().slice(0, 19);
const inputEpoch = () => Date.parse(`${$('#taskStart').value}+08:00`);
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
const releaseAt = (date) => Date.parse(`${addDays(date, -1)}T12:30:00+08:00`);
const project = (id) => model.config.projects.find((item) => item.id === id);
const taskJobs = (id) => model.jobs.filter((job) => job.taskId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const taskById = (id) => model.config.tasks.find((task) => task.id === id);

async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || '请求失败');
  return result;
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
  $('#sessionButton').textContent = '账号管理 · ' + model.accounts.length + ' 位用户';
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
  $('#accountSummary').textContent = !account?.exists ? '尚未导入登录状态'
    : account.verifiedAt ? '已验证：' + (account.user || account.name) + ' · ' + format(Date.parse(account.verifiedAt))
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
  return task.courts.map((id, i) => `${i + 1}. ${task.courtLabels[id] || (id.length > 15 ? '已保存场地（编辑查看）' : id)}`).join(' → ');
}
function renderTasks() {
  const tasks = model.config.tasks;
  const signature = JSON.stringify([tasks, model.accounts, model.jobs.map(({ id, taskId, status, error, successes }) => ({ id, taskId, status, error, successes })), tasks.map((task) => task.startAt <= Date.now())]);
  if (signature === renderTasks.signature) return;
  renderTasks.signature = signature;
  $('#planCount').textContent = `${model.jobs.filter((job) => activeStates.includes(job.status)).length} 个计划待执行 / 执行中`;
  if (!tasks.length) { $('#taskList').innerHTML = '<div class="empty">还没有预约任务。点击“新建任务”，安排下一次运动。</div>'; return; }
  $('#taskList').innerHTML = tasks.map((task) => {
    const history = taskJobs(task.id);
    const current = history.find((job) => activeStates.includes(job.status)) ?? history[0];
    const active = current && activeStates.includes(current.status);
    const status = current?.status ?? 'draft';
    const stateLabel = current?.mode === 'check' && status === 'success' ? '检查通过 · 未安排' : labels[status];
    const past = task.startAt <= Date.now();
    const expired = task.date < model.date;
    let timing = `${format(task.startAt)} 开始 · 每 ${task.intervalMs / 1000} 秒重试 · 最长 ${task.durationMs / 60_000} 分钟`;
    if (active) timing = current.status === 'scheduled' ? `已交给系统定时 · ${format(current.releaseAt)} 开始` : timing;
    return `<article class="task-card" data-task="${escape(task.id)}"><div class="task-head"><div><div class="task-heading"><h3>${escape(task.name)}</h3><span class="project-tag">${escape(task.projectLabel)}</span></div><p class="task-date">${escape(task.date)} · ${escape(accountLabel(task.accountId))} · 粤海校区</p></div><span class="badge ${status}">${escape(stateLabel)}</span></div><div class="task-content"><div><p class="caption">预约时段</p><div class="chips">${task.times.map((time) => `<span class="chip">${escape(time)}</span>`).join('')}</div></div><div><p class="caption">场地优先顺序</p><p class="court-description">${escape(courtText(task))}</p><p class="same-court">${task.preferSameCourt ? '✓ 优先同一场地' : '各时段按原顺序独立尝试'}</p></div></div>${current?.error ? `<p class="task-error">${escape(current.error)}</p>` : ''}${current?.successes?.length ? `<p class="same-court">已约到 ${current.successes.length} 个时段 · ${current.successes.map((s) => `${escape(s.time)} ${escape(s.court)}`).join(' / ')}</p>` : ''}<div class="task-footer"><p>${escape(timing)}</p><div class="task-actions">${history.length ? '<button class="text-button" data-action="logs">日志</button>' : ''}${active ? `<button class="danger" data-action="stop" ${status === 'stopping' ? 'disabled' : ''}>停止并取消定时</button>` : `<button class="text-button" data-action="edit">编辑</button><button class="text-button danger-text" data-action="delete">删除</button><button class="secondary" data-action="check" ${expired ? 'disabled' : ''}>检查配置</button><button class="primary" data-action="run" ${expired ? 'disabled' : ''}>${past ? '立即预约' : '安排定时'}</button>`}</div></div></article>`;
  }).join('');
}
function renderLogs() {
  if (!$('#logDialog').open) return;
  const history = taskJobs(model.logTask);
  const selected = $('#logHistory').value;
  $('#logHistory').innerHTML = history.map((job) => `<option value="${job.id}">${escape(format(Date.parse(job.createdAt)))} · ${job.mode === 'check' ? '配置检查' : '预约'} · ${labels[job.status]}</option>`).join('');
  if (history.some((job) => job.id === selected)) $('#logHistory').value = selected;
  const job = history.find((job) => job.id === $('#logHistory').value);
  $('#stopLogButton').hidden = !job || !activeStates.includes(job.status);
  $('#stopLogButton').disabled = job?.status === 'stopping';
  $('#deleteLogButton').disabled = !job || activeStates.includes(job.status);
  $('#logResult').innerHTML = job ? `<p>用户：${escape(job.accountName || accountLabel(job.accountId))} · 状态：${escape(labels[job.status])}${job.mode === 'check' ? '（未下单）' : ''}</p>${(job.successes ?? []).map((s) => `<p>✓ ${escape(s.date)} ${escape(s.time)} · ${escape(s.court)}${s.orderId ? ` · 订单 ${escape(s.orderId)}` : ''}</p>`).join('')}${job.error ? `<p class="error">${escape(job.error)}</p>` : ''}` : '';
  const box = $('#logBox');
  const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = job?.logs?.length ? job.logs.map((entry) => `<div class="log-line ${escape(entry.level)}"><time>${escape(format(Date.parse(entry.time)))}</time>${escape(entry.message)}${entry.details?.courts ? `\n${escape(entry.details.courts.join(' → '))}` : ''}${entry.details?.message ? ` · ${escape(entry.details.message)}` : ''}</div>`).join('') : '<p class="muted">记录已保存，执行开始后会在这里显示日志。</p>';
  if (bottom) box.scrollTop = box.scrollHeight;
}
async function refreshJobs() {
  const data = await api('/api/jobs'); model.jobs = data.jobs;
  renderTasks(); renderLogs();
}
async function bootstrap() {
  const data = await api('/api/bootstrap');
  Object.assign(model, { config: data.config, jobs: data.jobs, session: data.session, date: data.serverDate,
    accounts: data.accounts ?? [{ id: 'default', name: '我的账号', ...data.session }] });
  $('#schedulerHint').textContent = `${data.scheduler}。日志保存在本机，重新打开即可查看。`;
  renderSession(); renderTasks();
  if (data.auth?.status === 'running') pollAuth();
}
function closeTask() { model.token++; $('#taskDialog').close(); }
$$('[data-close]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.close === 'task') closeTask(); else $(`#${button.dataset.close}Dialog`).close();
}));
$('#taskDialog').addEventListener('cancel', () => { model.token++; });
function schedulePreview() {
  const at = releaseAt($('#taskDate').value);
  $('#schedulePreview').textContent = `学校放号：${format(at)}。${at <= Date.now() ? '已开放，可立即预约或另设捡漏时间。' : '默认按此时间开始，也可另设捡漏时间。'}`;
  $('#saveTaskButton').textContent = inputEpoch() > Date.now() ? '保存并安排' : '保存并立即预约';
}
function renderTimes() {
  $('#timeOptions').innerHTML = model.options.map((time) => `<button type="button" class="time-option ${model.times.includes(time) ? 'selected' : ''}" data-time="${escape(time)}" aria-pressed="${model.times.includes(time)}">${escape(time)}</button>`).join('');
}
function renderCourts() {
  const all = model.order.includes('*');
  $('#allCourts').setAttribute('aria-pressed', String(all));
  $('#courtSequence').innerHTML = all ? '全部场地 · 按学校返回的顺序尝试' : model.order.length
    ? model.order.map((id, i) => `<span class="order-chip"><b>${i + 1}</b>${escape(model.courtLabels[id] || id)}</span>`).join('<span aria-hidden="true">→</span>')
    : '<span class="muted">尚未选择场地</span>';
  $('#courtList').innerHTML = model.courts.map((court) => {
    const index = all ? -1 : model.order.indexOf(court.id);
    return `<button type="button" class="court-card ${index >= 0 ? 'selected' : ''}" data-court="${escape(court.id)}" aria-pressed="${index >= 0}" aria-label="${escape(court.name)}${index >= 0 ? `，第 ${index + 1} 优先` : ''}"><span class="court-order">${index >= 0 ? index + 1 : '+'}</span><span class="court-name">${escape(court.name)}<span class="court-venue">${escape(court.venue)}</span></span></button>`;
  }).join('');
}
async function loadProject(task) {
  const token = ++model.token;
  const id = $('#taskProject').value;
  model.times = [...(task?.times ?? [])]; model.options = [...model.times];
  model.order = [...(task?.courts ?? ['*'])]; model.courts = [];
  model.courtLabels = { ...(task?.courtLabels ?? {}) };
  $('#preferSameCourt').checked = task?.preferSameCourt ?? id === 'volleyball';
  renderTimes(); renderCourts();
  $('#timeNote').textContent = '正在读取学校时段目录……';
  $('#courtList').innerHTML = '<span class="muted">正在读取场地……</span>';
  const results = await Promise.allSettled([api(`/api/projects/${id}/times?accountId=${encodeURIComponent($('#taskAccount').value)}`), api(`/api/projects/${id}/courts?accountId=${encodeURIComponent($('#taskAccount').value)}`)]);
  if (token !== model.token || !$('#taskDialog').open) return;
  const [times, courts] = results;
  if (times.status === 'fulfilled') {
    model.options = [...new Set([...times.value.times.map((t) => t.value), ...model.times])].sort();
    $('#timeNote').textContent = `参考 ${times.value.date} 的时段目录，实际开放以学校为准。`;
  } else $('#timeNote').textContent = `时段读取失败：${times.reason.message}。可重试或手动填写真实时段。`;
  renderTimes();
  if (courts.status === 'fulfilled') {
    model.courts = courts.value.courts;
    for (const court of model.courts) {
      // Older preferences may contain names rather than IDs.
      model.order = model.order.map((value) => value === court.name ? court.id : value);
      model.courtLabels[court.id] = court.name;
    }
    renderCourts();
    if (!model.courts.length) $('#courtList').innerHTML = '<p class="muted">没有读取到场地，稍后重新打开编辑即可重试。</p>';
  } else $('#courtList').innerHTML = `<p class="muted">场地读取失败：${escape(courts.reason.message)}。已保存的选择仍保留。</p>`;
}
function openTask(task = null) {
  if (model.busy) return toast('正在保存，请稍候');
  model.editing = task?.id ?? null;
  $('#taskForm').reset(); $('#taskError').textContent = '';
  $('#taskAccount').value = task?.accountId ?? 'default';
  $('#taskDialogTitle').textContent = task ? '编辑任务' : '新建任务';
  $('#taskProject').innerHTML = model.config.projects.map((p) => `<option value="${p.id}">${escape(p.label)}</option>`).join('');
  $('#taskProject').value = task?.projectId || model.config.projects[0].id;
  $('#taskDate').innerHTML = Array.from({ length: 8 }, (_, i) => {
    const day = addDays(model.date, i); return `<option value="${day}">${day}${i === 0 ? ' · 今天' : i === 1 ? ' · 明天' : ''}</option>`;
  }).join('');
  $('#taskDate').value = task && task.date >= model.date && task.date <= addDays(model.date, 7) ? task.date : addDays(model.date, 1);
  $('#taskName').value = task?.name ?? '';
  $('#taskStart').value = localInput(task?.startAt ?? Math.max(releaseAt($('#taskDate').value), Date.now()));
  $('#taskInterval').value = (task?.intervalMs ?? 100) / 1000;
  $('#taskDuration').value = (task?.durationMs ?? 60_000) / 60_000;
  schedulePreview(); $('#taskDialog').showModal();
  void loadProject(task);
}
$('#addTaskButton').addEventListener('click', () => openTask());
$('#taskProject').addEventListener('change', () => { $('#taskError').textContent = ''; void loadProject(); });
$('#taskDate').addEventListener('change', () => { $('#taskStart').value = localInput(Math.max(releaseAt($('#taskDate').value), Date.now())); schedulePreview(); });
$('#taskStart').addEventListener('input', schedulePreview);
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
  const intent = event.submitter?.value ?? 'draft';
  const body = { accountId: $('#taskAccount').value, projectId: $('#taskProject').value, name: $('#taskName').value,
    date: $('#taskDate').value, times: model.times, courts: model.order, courtLabels: model.courtLabels,
    preferSameCourt: $('#preferSameCourt').checked, enabled: true,
    startAt: inputEpoch(), intervalMs: Number($('#taskInterval').value) * 1000, durationMs: Number($('#taskDuration').value) * 60_000 };
  model.busy = true;
  $$('#taskForm button[type="submit"]').forEach((b) => { b.disabled = true; });
  try {
    const data = await api(model.editing === null ? '/api/tasks' : `/api/tasks/${model.editing}`, model.editing === null ? 'POST' : 'PUT', body);
    model.config = data.config; renderTasks(); closeTask();
    if (intent === 'schedule') confirmRun(taskById(data.taskId)); else toast('草稿已保存，尚未安排执行');
  } catch (error) { $('#taskError').textContent = error.message; }
  finally { model.busy = false; $$('#taskForm button[type="submit"]').forEach((b) => { b.disabled = false; }); }
});
function confirmRun(task) {
  const mode = task.startAt > Date.now() ? 'schedule' : 'now';
  model.pending = { taskId: task.id, mode };
  $('#confirmTitle').textContent = mode === 'now' ? '现在开始预约？' : '确认定时安排';
  $('#confirmSummary').textContent = `${task.name} · ${task.date}\n用户：${accountLabel(task.accountId)}\n${task.times.join('、')}\n${mode === 'now' ? '保存的开始时间已过，将在确认后立即尝试。' : `${format(task.startAt)} 开始，关闭网页也会执行。`}\n每 ${task.intervalMs / 1000} 秒重试，最长 ${task.durationMs / 60_000} 分钟。`;
  $('#confirmSummary').style.whiteSpace = 'pre-line';
  $('#confirmError').textContent = '';
  $('#confirmRunButton').textContent = mode === 'now' ? '确认立即预约' : '确认安排';
  $('#confirmDialog').showModal();
}
$('#confirmRunButton').addEventListener('click', async () => {
  const button = $('#confirmRunButton'); button.disabled = true;
  try {
    const data = await api(`/api/tasks/${model.pending.taskId}/run`, 'POST', { mode: model.pending.mode, confirm: 'SUBMIT' });
    model.config = data.config; $('#confirmDialog').close(); await refreshJobs(); toast('任务已交给后台执行器');
  } catch (error) {
    $('#confirmError').textContent = `${error.message}。任务草稿仍保留。`;
    // A failed native registration may still have migrated a legacy task ID.
    await bootstrap().catch(() => {});
  }
  finally { button.disabled = false; }
});
$('#taskList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]'), row = button?.closest('[data-task]');
  if (!row || button.disabled) return;
  const task = taskById(row.dataset.task), action = button.dataset.action;
  button.disabled = true;
  try {
    if (action === 'edit') openTask(task);
    if (action === 'run') confirmRun(task);
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
      await refreshJobs(); toast('已请求停止并移除定时安排');
    }
    if (action === 'delete' && confirm(`删除“${task.name}”、系统定时项及本地日志？日志将移入本地回收目录；学校预约不会取消。`)) {
      const data = await api(`/api/tasks/${task.id}`, 'DELETE'); model.config = data.config;
      await refreshJobs(); toast('已删除任务，本地日志已移入 .data/trash');
    }
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#logHistory').addEventListener('change', renderLogs);
$('#stopLogButton').addEventListener('click', async () => {
  try { await api(`/api/jobs/${$('#logHistory').value}/stop`, 'POST', {}); await refreshJobs(); }
  catch (error) { toast(error.message); }
});
$('#deleteLogButton').addEventListener('click', async () => {
  if (!confirm('移除这次执行的定时项，并把日志移入本地回收目录？')) return;
  try { await api(`/api/jobs/${$('#logHistory').value}`, 'DELETE'); await refreshJobs(); }
  catch (error) { toast(error.message); }
});
$('#sessionButton').addEventListener('click', () => { $('#authDialog').showModal(); });
async function authAction(button, action) {
  button.disabled = true;
  try { await action(); } catch (error) { $('#authProgress').textContent = error.message; }
  finally { button.disabled = false; }
}

$('#authAccount').addEventListener('change', () => { renderAccountSummary(); $('#authProgress').textContent = ''; $('#curlInput').value = ''; $('#loginJsonExport').value = ''; $('#loginJsonExport').hidden = true; });
$('#taskAccount').addEventListener('change', () => {
  void loadProject({ times: model.times, courts: model.order, courtLabels: model.courtLabels,
    preferSameCourt: $('#preferSameCourt').checked });
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
    $('#authProgress').textContent = data.auth.logs.slice(-5).map((line) => line.message).join('\n');
    if (data.auth.status === 'running') pollAuth.timer = setTimeout(pollAuth, 1000);
    else await refreshAccounts();
  } catch (error) { $('#authProgress').textContent = error.message; }
}
$('#startAuthButton').addEventListener('click', (event) => authAction(event.currentTarget, async () => {
  await api('/api/auth/start', 'POST', { accountId: $('#authAccount').value }); await pollAuth();
}));
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
  const data = await api('/api/accounts/' + $('#authAccount').value + '/verify', 'POST', {});
  model.accounts = data.accounts; renderSession(); $('#authProgress').textContent = '验证成功：' + data.account.user;
}));
$('#deleteSessionButton').addEventListener('click', (event) => authAction(event.currentTarget, async () => {
  if (!confirm('清除此用户的登录？该用户已安排的任务将无法预约。')) return;
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
  if (!confirm('退出管理服务？已安排的后台预约会继续，重新打开程序可恢复管理。')) return;
  try { await api('/api/app/quit', 'POST', {}); toast('管理服务已退出，可以关闭网页'); }
  catch (error) { toast(error.message); }
});
async function poll() {
  try {
    await refreshJobs(); $('#connectionError').hidden = true;
  } catch { $('#connectionError').hidden = false; $('#connectionError').textContent = '暂时无法连接管理服务。后台任务独立执行；请重新启动管理界面以查看最新状态。'; }
  setTimeout(poll, 1500);
}
bootstrap().then(poll).catch((error) => {
  $('#connectionError').hidden = false; $('#connectionError').textContent = `页面读取失败：${error.message}`;
});
