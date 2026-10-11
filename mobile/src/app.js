import { installMenus, planExperience, visiblePlans, repeatPlan, friendlyDate, selectionSummary, matchingMobileRun } from '../../shared/experience.js';
import { device, native, nativeTransport } from './device.js';
import { saveSchoolLogin } from './login.js';
import { MobileStore, pendingMobileRequests, reviewedMobileRuns } from './store.js';
import { ForegroundExecution, validatePlan } from './execution.js';
import { createConnection, verifyAccount, readCatalog } from './school.js';
import { PROJECTS } from '../../shared/projects.js';
import { parseSessionText } from '../../shared/session-format.js';
import { shanghaiDate, addDays, splitTimeSlot } from '../../shared/utils.js';
import { bookingReleaseAt } from '../../shared/runner.js';
import { SessionExpiredError } from '../../shared/errors.js';
import { GOAL_LABELS } from '../../shared/booking-goal.js';
import { reviewBookings } from '../../shared/booking-review.js';
import { resolveTargets } from '../../shared/planner.js';
import { targetFor } from './execution.js';
import { APP_URL } from '../../shared/constants.js';
import { exportDiagnostics } from '../../shared/diagnostics.js';

installMenus();
const $ = (s) => document.querySelector(s);
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const format = (epoch) => new Date(epoch).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const labels = { preparing: '准备中', waiting: '等待放号', booking: '抢场中', stopping: '正在停止', stopped: '已停止',
  interrupted: '已中断', success: '已完成', partial: '部分成功', error: '执行失败', missed: '已错过', limited: '上限已达 · 未预约', expired: '时段已过期', no_result: '未约到' };
const store = new MobileStore(device);
const selected = new Set();
let ready = false, foreground = !document.hidden, editPlan = null, editAccount = null, catalogToken = 0, currentTab = 'plans';
let choices = { times: [], courts: [], labels: {}, catalog: null };
let loginAccount = null, authBusy = false, notifiedRun = null, catalogController = null;
function cancelCatalog() { catalogToken++; catalogController?.abort(); catalogController = null; $('#loadCatalog').disabled = false; }
let planFilter = 'recent', planQuery = '', confirmSelection = [];
let archivedRuns = [], archiveCursor = '', archiveHasMore = true;
const historyRuns = () => [...store.state.runs, ...archivedRuns.filter((old) => !store.state.runs.some((run) => run.id === old.id))];
const planContext = (plan) => ({ plan: { ...plan, projectLabel: PROJECTS.find((p) => p.id === plan.project)?.label }, experience: planExperience(plan, { account: store.state.accounts.find((a) => a.id === plan.accountId), run: matchingMobileRun(plan, store.state.runs) }) });
const execution = new ForegroundExecution({ store, device, createApi: (account, token) => createConnection(store, device, account, token),
  changed: () => render(), isForeground: () => foreground && !document.hidden });
const accountName = (id) => store.state.accounts.find((a) => a.id === id)?.name ?? '账号已删除';
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4500); }
function editable() { if (!ready) throw new Error('数据尚未加载'); if (execution.active) throw new Error('请先停止当前执行，再修改方案或账号'); if (authBusy) throw new Error('正在处理，请稍候'); }
async function saveChange(changes) {
  editable(); authBusy = true; render();
  try { await store.update(changes); }
  finally { authBusy = false; render(); }
}
function action(fn, errorTarget) { return async (event) => {
  try { await fn(event); } catch (error) { if (errorTarget) $(errorTarget).textContent = error.message; else toast(error.message); }
}; }
function tab(name) {
  currentTab = name;
  for (const key of ['plans', 'results', 'accounts']) $('#' + key + 'Page').hidden = key !== name;
  $('#batchBar').hidden = name !== 'plans' || (!selected.size && !execution.active);
  document.querySelectorAll('[data-tab]').forEach((el) => el.setAttribute('aria-current', el.dataset.tab === name ? 'page' : 'false'));
}
function courtDescription(plan) { return plan.courts.includes('*') ? '按学校顺序尝试全部场地'
  : plan.courts.map((id, i) => `${i + 1}. ${plan.courtLabels?.[id] ?? id}`).join(' → ')
    + (plan.includeOtherCourts ? ' → 其余场地（学校顺序）' : '（仅尝试已选场地）'); }
function render() {
  if (!ready) return;
  if (!execution.active && execution.current?.finishedAt && notifiedRun !== execution.current.id) {
    notifiedRun = execution.current.id; toast(`本次执行：${labels[execution.current.status]}，新预约 ${execution.current.successes.filter((s) => !s.reused).length} 段。请核对学校预约 / 付款。`);
  }
  const contexts = store.state.plans.map(planContext);
  const eligible = new Set(contexts.filter((c) => c.experience.canStart).map((c) => c.plan.id));
  if (!execution.active) for (const id of selected) if (!eligible.has(id)) selected.delete(id);
  $('#newPlan').disabled = $('#newAccount').disabled = $('#schoolLogin').disabled = execution.active || authBusy;
  $('#planForm button[type="submit"]').disabled = $('#accountForm button[type="submit"]').disabled = authBusy;
  $('#begin').disabled = execution.active || authBusy || selected.size === 0;
  $('#stop').hidden = !execution.active;
  $('#selectedCount').textContent = execution.active ? '当前有执行正在进行' : selected.size ? `已选 ${selected.size} 个方案` : '可单独启动，也可勾选批量执行';
  $('#batchBar').hidden = currentTab !== 'plans' || (!selected.size && !execution.active);
  const signature = JSON.stringify([store.state.plans, store.state.accounts.map((a) => [a.id, a.name, a.user, a.verifiedAt]), [...selected], execution.active, authBusy, contexts.map((c) => c.experience), planFilter, planQuery]);
  if (render.signature !== signature) {
    render.signature = signature;
    const next = visiblePlans(contexts)[0], shown = visiblePlans(contexts, { filter: planFilter, query: planQuery });
    const attention = contexts.filter((c) => ['attention', 'login'].includes(c.experience.phase));
    const connected = store.state.accounts.length > 0, hasPlans = contexts.length > 0;
    const onlyExpired = hasPlans && contexts.every((context) => context.experience.expired);
    const previous = onlyExpired ? [...contexts].sort((a, b) => b.plan.date.localeCompare(a.plan.date))[0] : null;
    const firstUse = !store.state.runs.length;
    const step = !connected ? 0 : !hasPlans || onlyExpired ? 1 : 2;
    $('.mobile-overview').hidden = !execution.active && connected && hasPlans && !attention.length && !firstUse;
    $('#setupSteps').hidden = execution.active || attention.length > 0;
    document.querySelectorAll('[data-setup-step]').forEach((item) => {
      const current = Number(item.dataset.setupStep);
      item.classList.toggle('done', current < step); item.classList.toggle('current', current === step);
      if (current === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
    $('#newPlan').hidden = !hasPlans;
    $('.search-box').hidden = $('.list-tools').hidden = $('#plans').hidden = !hasPlans;
    $('#overviewTitle').textContent = execution.active ? '正在执行预约' : !connected ? '先登录学校账号' : attention.length ? `${attention.length} 个方案需要处理` : !hasPlans ? '账号已连接，创建第一份方案' : onlyExpired ? '之前的方案已过期' : '方案已保存，等你手动开始';
    $('#overviewHint').textContent = execution.active ? '保持前台与亮屏，在结果页查看进度。' : !connected ? '验证身份后，就可以创建预约方案。' : attention.length ? '先核对学校订单，再决定剩余时段。' : !hasPlans ? '选择日期、时段和场地，保存你的偏好。' : onlyExpired ? '重新选择日期，原场地和时段可以继续用。' : next?.experience.canStart ? '点击开始，确认后才会提交预约。' : next?.experience.hint ?? '从「全部」查看已保存的方案。';
    const overviewAction = $('#overviewAction'); overviewAction.hidden = false;
    overviewAction.textContent = execution.active ? '查看执行进度' : !connected ? '学校账号登录' : attention.length ? '查看需处理方案' : !hasPlans ? '创建预约方案' : onlyExpired ? '重新选日期' : next?.experience.canStart ? '开始本次执行' : '查看方案';
    overviewAction.disabled = authBusy;
    overviewAction.onclick = action(async () => {
      if (execution.active) tab('results'); else if (!connected) openLogin(); else if (attention.length) { planQuery = ''; $('#planSearch').value = ''; planFilter = 'attention'; render(); } else if (!hasPlans) openPlan(); else if (onlyExpired) openPlan(null, repeatPlan(previous.plan)); else if (next?.experience.canStart) await planPrimary(next); else { planQuery = ''; $('#planSearch').value = ''; planFilter = 'all'; render(); $('#plans').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    });
    document.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === planFilter)));
    $('#planListCount').textContent = `${shown.length} / ${contexts.length}`;
    const expanded = new Set([...document.querySelectorAll('[data-plan-details][open]')].map((el) => el.dataset.planDetails));
    $('#plans').innerHTML = shown.length ? shown.map(({ plan: p, experience: ex }) => {
      const firstCourt = p.courtLabels?.[p.courts[0]] || (p.courts[0]?.length <= 15 ? p.courts[0] : '已选场地');
      const courtBrief = p.courts.includes('*') ? '全部场地' : `首选 ${firstCourt}${p.courts.length > 1 ? ` 等 ${p.courts.length} 场` : ''}`;
      const primary = ex.phase === 'attention' ? 'review' : ex.phase === 'login' ? 'login' : ['active', 'done'].includes(ex.phase) ? 'results' : ex.phase === 'expired' ? 'copy' : 'start';
      return `<article class="task-card phase-${ex.phase}" data-plan="${escape(p.id)}">
        <div class="task-head"><label class="plan-select"><input type="checkbox" aria-label="选择方案 ${escape(p.name)}" data-select="${escape(p.id)}" ${selected.has(p.id) ? 'checked' : ''} ${!ex.canStart || execution.active || authBusy ? 'disabled' : ''}><div><div class="plan-title-row"><h3>${escape(p.name)}</h3><span class="project-tag">${escape(p.projectLabel)}</span></div><p class="task-date">${escape(friendlyDate(p.date))} · ${escape(accountName(p.accountId))}</p></div></label><span class="badge ${ex.phase}">${escape({ active: '执行中', attention: '需核对', login: '待登录', ready: '可启动', future: '待放号', done: '已完成', expired: '已过期' }[ex.phase])}</span></div>
        <div class="task-content"><div class="chips">${p.times.map((t) => `<span class="chip">${escape(t)}</span>`).join('')}</div><p class="plan-brief">${escape(GOAL_LABELS[p.bookingGoal ?? (new Set(p.times).size === 1 ? 'one' : 'two')])} · ${escape(courtBrief)}${p.preferSameCourt ? ' · 同场优先' : ''}</p></div>
        <details class="plan-details" data-plan-details="${escape(p.id)}" ${expanded.has(p.id) ? 'open' : ''}><summary>方案详情</summary><div><p class="court-description">${escape(courtDescription(p))}</p><p class="plan-timing">${format(bookingReleaseAt(p.date))} 放号 · 每 ${p.intervalMs / 1000} 秒重试 · 最长 ${p.durationMs / 60000} 分钟</p></div></details><p class="next-hint">${escape(ex.hint)}</p>
        <div class="task-actions"><button class="text-button" data-edit="${escape(p.id)}" ${execution.active || authBusy ? 'disabled' : ''}>编辑</button>
        <details class="more-actions"><summary aria-label="更多方案操作">···</summary><div>${ex.phase !== 'expired' ? `<button class="text-button" data-copy="${escape(p.id)}" ${execution.active || authBusy ? 'disabled' : ''}>再约一次</button>` : ''}<button class="text-button" data-review="${escape(p.id)}" ${execution.active || authBusy ? 'disabled' : ''}>核对与重试</button><button class="text-button danger-text" data-delete="${escape(p.id)}" ${execution.active || authBusy ? 'disabled' : ''}>删除方案</button></div></details>
        <button class="primary plan-primary" data-${primary}="${escape(p.id)}" ${ex.phase === 'future' || (execution.active && ex.phase !== 'active') || authBusy ? 'disabled' : ''}>${escape(ex.action)}</button></div></article>`;
    }).join('') : `<div class="empty"><h3>${!contexts.length ? '暂无预约方案' : '没有符合条件的方案'}</h3><p>${!contexts.length ? '选择日期、时段和场地，保存后手动启动。' : '调整搜索或筛选，历史方案在「全部」中查看。'}</p><button class="secondary" data-empty="${!contexts.length ? 'new' : 'all'}">${!contexts.length ? '新建方案' : '查看全部方案'}</button></div>`;
    $('#accounts').innerHTML = store.state.accounts.length ? store.state.accounts.map((a) => `<article class="task-card"><h3>${escape(a.name)}</h3><p class="task-date">${a.verifiedAt ? '上次验证：' + escape(a.user) + ' · ' + escape(format(a.verifiedAt)) + '（启动时重新验证）' : '登录已保存，尚未验证'}</p><div class="task-actions">
      <button class="secondary" data-relogin="${a.id}" ${execution.active || authBusy ? 'disabled' : ''}>重新登录</button><button class="text-button" data-verify="${a.id}" ${execution.active || authBusy ? 'disabled' : ''}>验证</button><button class="text-button" data-export="${a.id}">查看 / 复制 JSON</button><button class="text-button" data-update="${a.id}" ${execution.active || authBusy ? 'disabled' : ''}>导入更新</button><button class="text-button danger-text" data-remove="${a.id}" ${execution.active || authBusy ? 'disabled' : ''}>删除</button></div></article>`).join('') : '<div class="empty">尚未连接账号。<br>使用学校登录，或导入登录文件。</div>';
  }
  const attentionCount = store.state.runs.filter((r) => !r.finishedAt || pendingMobileRequests(r).length).length;
  $('#resultsBadge').hidden = !attentionCount; $('#resultsBadge').textContent = attentionCount;
  renderProgress();
  const shownRuns = historyRuns();
  $('#loadHistory').hidden = execution.active || !(store.state.archivedRunCount && archiveHasMore);
  $('#loadHistory').disabled = authBusy;
  const runSignature = JSON.stringify([execution.active, authBusy, shownRuns.map((run) => [run.id, run.status, run.reviewedOutcome, run.error, run.finishedAt,
    run.successes, run.pendingRequests, run.inFlight, run.items, run.logs.length, run.logs.at(-1)])]);
  if (render.runSignature !== runSignature) {
    render.runSignature = runSignature;
    const expanded = new Set([...document.querySelectorAll('[data-log][open]')].map((el) => el.dataset.log));
    $('#runs').innerHTML = shownRuns.length ? shownRuns.map((run) => `<article class="task-card">
      <div class="task-head"><h3>${escape(run.plans.map((p) => p.name).join('、'))}</h3><span class="badge ${escape(run.status)}">${run.reviewedOutcome === 'success' ? '已核实完成' : labels[run.status] ?? run.status}</span></div>
      <p class="run-meta">${format(run.startedAt)} · ${run.mode === 'auto' ? '按各方案放号时间执行' : run.mode === 'now' ? '立即尝试' : '等待 12:30 放号'}</p>
      ${run.error ? `<p class="task-error">${escape(run.error)}</p>` : ''}
      ${pendingMobileRequests(run).map((request) => `<p class="${run.finishedAt || request.state === 'unknown' ? 'task-error' : 'run-meta'}">${run.finishedAt || request.state === 'unknown' ? '待核对' : request.state === 'prepared' ? '已准备' : '请求已发出，等待学校响应'}：${escape(request.plan)} ${escape(request.time)} ${escape(request.court)}</p>`).join('')}
      ${run.successes.map((s) => `<p class="run-result">✓ ${escape(accountName(s.accountId))} · ${escape(s.date)}<br>${escape(s.time)} · ${escape(s.court)}${s.reused ? (s.school ? '（学校已有，未重复提交）' : '（同批次已约，未重复提交）') : ''}${s.orderId ? '<br>订单：' + escape(s.orderId) : ''}</p>`).join('') || '<p class="run-meta">尚无成功记录</p>'}
      <a href="${APP_URL.replace('#/sportVenue', '#/myBooking')}" target="_blank" rel="noopener noreferrer">打开学校“我的预约”核对 / 付款</a>${run.items.map((i) => `<p class="run-meta">${escape(i.name)}：${i.reviewedOutcome === 'success' ? '已核实完成' : labels[i.status] ?? i.status}${i.limited && i.status === 'partial' ? ' · 已达两时段上限' : ''}${i.error ? ' · ' + escape(i.error) : ''}</p>${(i.slots ?? []).map((slot) => `<p class="run-meta">${escape(slot.time)}：${escape({ success: '已成功', expired: '已过期', limited: '已达上限', goal_reached: '目标已达，未尝试', ineligible: '不符合连续目标，未尝试', conflict: '与本批次已约场地冲突', unfilled: '未约到', error: '发生错误' }[slot.status] ?? slot.status)}${slot.lastMessage ? ' · ' + escape(slot.lastMessage) : ''}</p>`).join('')}`).join('')}
      <details data-log="${run.id}" ${expanded.has(run.id) ? 'open' : ''}><summary>详细日志（${run.logs.length} 条）</summary><div class="run-logs">${expanded.has(run.id) ? run.logs.map((l) => escape(`${format(l.time)} ${l.level} ${l.message}${l.details ? ' ' + JSON.stringify(l.details) : ''}`)).join('\n') : ''}</div></details>
      <div class="task-actions"><button class="text-button" data-run-export="${run.id}">导出记录</button>${run.finishedAt ? run.plans.map((plan) => `<button class="text-button" data-run-review="${run.id}" data-review-plan="${escape(plan.id)}" ${execution.active || authBusy ? 'disabled' : ''}>${run.plans.length > 1 ? escape(plan.name) + ' · ' : ''}核对此次执行</button>`).join('') : ''}${run.finishedAt && store.state.runs.some((hot) => hot.id === run.id) ? `<button class="text-button danger-text" data-run-delete="${run.id}" ${execution.active || authBusy ? 'disabled' : ''}>删除记录</button>` : ''}</div></article>`).join('') : '<div class="empty">还没有执行记录。<br>预约成功后请到学校系统付款。</div>';
  }
}
function renderProgress() {
  $('#liveStatus').hidden = !execution.active;
  if (!execution.active) return;
  const run = execution.current;
  const text = run.items.map((item) => {
    if (item.status === 'waiting') { const left = Math.max(0, Math.ceil((item.releaseAt - Date.now()) / 1000));
      return `${item.name}：倒计时 ${Math.floor(left / 3600)}:${String(Math.floor(left / 60) % 60).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`; }
    return `${item.name}：${labels[item.status] ?? item.status}`;
  }).join('\n');
  $('#liveStatus').textContent = (run.status === 'stopping' ? '正在停止，等待已发出的请求返回。\n' : '执行中保持亮屏，请勿锁屏或切换 App。\n') + text;
}
function loadCached() {
  cancelCatalog();
  choices.catalog = store.state.catalogs[$('#planAccount').value + ':' + $('#planProject').value] ?? null;
  renderChoices();
}
function renderChoices() {
  $('#bookingGoalHint').hidden = $('#bookingGoal').value !== 'consecutive';
  const date = $('#planDate').value;
  if (date) { const experience = planExperience({ date, times: choices.times }, { account: store.state.accounts.find((a) => a.id === $('#planAccount').value) });
    $('#planSchedule').textContent = `学校放号：${format(experience.releaseAt)} · ${experience.hint}`; }
  const summary = selectionSummary(choices.times, choices.courts, $('#bookingGoal').value);
  $('#selectionSummary').textContent = summary.text; $('#selectionSummary').classList.toggle('complete', summary.valid);
  $('#allCourts').setAttribute('aria-pressed', String(choices.courts.includes('*')));
  const catalog = choices.catalog;
  $('#catalogNote').textContent = catalog ? `目录参考 ${catalog.dates?.length ? catalog.dates.join('、') : catalog.date}${catalog.cached ? '，含此前读到的目录' : ''}，不代表目标日期可订。`
    + (catalog.partial ? ' 部分目录暂未读到，可重新读取补充。' : ' 可点击重新读取。') : '请先读取学校目录；也可选择按学校顺序全部尝试。';
  const times = [...new Set([...(catalog?.times ?? []), ...choices.times])].sort();
  $('#times').innerHTML = times.map((time) => `<button type="button" class="time-option ${choices.times.includes(time) ? 'selected' : ''}" data-time="${escape(time)}" aria-pressed="${choices.times.includes(time)}">${escape(time)}</button>`).join('');
  const courts = [...(catalog?.courts ?? [])];
  for (const id of choices.courts.filter((c) => c !== '*')) if (!courts.some((c) => c.id === id)) courts.push({ id, name: choices.labels[id] ?? '已保存场地' });
  $('#courts').innerHTML = courts.map((court) => { const n = choices.courts.indexOf(court.id); choices.labels[court.id] = court.name;
    return `<button type="button" class="court-card ${n >= 0 ? 'selected' : ''}" data-court="${escape(court.id)}" aria-pressed="${n >= 0}"><span class="court-order">${n >= 0 ? n + 1 : '+'}</span><span class="court-name">${escape(court.name)}</span></button>`; }).join('');
  $('#sequence').innerHTML = choices.courts.includes('*') ? '按学校顺序尝试全部场地' : choices.courts.map((id, i) => `<span class="order-chip">${i + 1}. ${escape(choices.labels[id] ?? id)}<button type="button" data-move="${i}" data-step="-1" aria-label="上移 ${escape(choices.labels[id] ?? id)}" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move="${i}" data-step="1" aria-label="下移 ${escape(choices.labels[id] ?? id)}" ${i === choices.courts.length - 1 ? 'disabled' : ''}>↓</button></span>`).join(' → ');
}
function openPlan(id, source = null) {
  editable();
  if (!store.state.accounts.length) { tab('accounts'); toast('请先登录或导入一个账号'); return; }
  const plan = source ?? store.state.plans.find((p) => p.id === id); editPlan = source ? null : plan?.id ?? null;
  $('#planForm').reset(); $('#planError').textContent = ''; $('#planTitle').textContent = source ? '再约一次 · 确认新日期' : plan ? '编辑方案' : '新建方案';
  $('#planName').value = plan?.name ?? '';
  $('#planAccount').innerHTML = store.state.accounts.map((a) => `<option value="${a.id}">${escape(a.name)}</option>`).join('');
  $('#planAccount').value = plan?.accountId ?? store.state.accounts[0].id;
  $('#planProject').innerHTML = PROJECTS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  $('#planProject').value = plan?.project ?? 'badminton';
  const dates = Array.from({ length: 8 }, (_, i) => addDays(shanghaiDate(), i));
  $('#planDate').innerHTML = dates.map((d) => `<option value="${d}">${friendlyDate(d)}</option>`).join('');
  if (plan && !dates.includes(plan.date)) $('#planDate').insertAdjacentHTML('afterbegin', `<option value="${escape(plan.date)}">${escape(plan.date)} · 已过期，请选择新日期</option>`);
  $('#planDate').value = plan?.date ?? dates[1];
  $('#bookingGoal').value = plan?.bookingGoal ?? (plan && new Set(plan.times).size === 1 ? 'one' : 'two');
  $('#sameCourt').checked = plan?.preferSameCourt ?? false;
  $('#includeOtherCourts').checked = plan?.includeOtherCourts ?? false;
  $('#interval').value = (plan?.intervalMs ?? 100) / 1000; $('#duration').value = (plan?.durationMs ?? 120000) / 60000;
  choices = { times: [...(plan?.times ?? [])], courts: [...(plan?.courts ?? [])], labels: { ...plan?.courtLabels }, catalog: null };
  loadCached(); $('#planDialog').showModal(); $('#planDialog').scrollTop = 0;
}
async function reviewPlan(id, originalPlan = null) {
  editable(); cancelCatalog();
  const plan = originalPlan ?? store.state.plans.find((p) => p.id === id);
  const account = store.state.accounts.find((a) => a.id === plan.accountId);
  if (!native) throw new Error('网页预览不能连接学校，请在手机 App 中核对');
  if (!account) throw new Error('方案账号已删除，请先连接账号');
  authBusy = true; render();
  try {
    const { api, client } = createConnection(store, device, account);
    let review;
    try {
      const identity = await api.getIdentity();
      if (account.userId && account.userId !== identity.id) throw new Error('学校身份不匹配，请更新登录');
      const target = resolveTargets({ targets: [targetFor(plan)] }, await api.getSportVenueData())[0];
      const matching = (run, record) => {
        const originals = run.plans.filter((p) => record.planId ? p.id === record.planId : p.name === record.plan || p.name === record.name);
        return record.accountId === plan.accountId && (record.project ? record.project === plan.project
          : !originals.length || originals.some((old) => old.project === plan.project));
      };
      const pending = store.state.runs.flatMap((run) => pendingMobileRequests(run).filter((record) => matching(run, record)));
      const known = store.state.runs.flatMap((run) => run.successes.filter((record) => matching(run, record)));
      review = reviewBookings({ plan, target, rows: await api.getAllBookings(), pending, known, now: Date.now() });
    } finally { await client.flush(); }
    // Matched school orders resolve their exact pending requests immediately,
    // including the goal-complete branch that previously returned too early.
    await store.update({ runs: reviewedMobileRuns(store.state.runs, plan, review) });
    const booked = review.booked.map((slot) => `已约：${slot.time} ${slot.court}`).join('\n');
    if (review.unresolved.length) {
      if (!confirm(review.unresolved.map((slot) => `${slot.time ?? '未识别时段'}：${slot.reason}`).join('\n') + '\n请先在学校人工核对。是否已确认以上所有未对应请求均没有订单或在途请求？')) return;
      await store.update({ runs: reviewedMobileRuns(store.state.runs, plan, review, { confirmedAbsent: true }) });
    }
    if (!review.remainingTimes.length) return toast([review.reason, booked].filter(Boolean).join('；') || '无需生成剩余方案');
    if (!confirm(`${booked}\n剩余：${review.remainingTimes.join('、')}\n保存一份新的剩余方案？不会自动预约。`)) return;
    const copy = { ...plan, id: crypto.randomUUID(), name: plan.name + ' · 剩余', times: review.remainingTimes, bookingGoal: review.remainingGoal, sameCourtAnchor: review.sameCourtAnchor };
    await store.update({ plans: [...store.state.plans, copy] }); selected.add(copy.id); tab('plans'); toast('剩余方案已保存，原方案和结果保留');
  } finally { authBusy = false; render(); }
}
function showText(title, value) { $('#textTitle').textContent = title; $('#exportText').value = value; $('#textDialog').showModal(); }
function exportAccount(id) { const account = store.state.accounts.find((a) => a.id === id);
  showText('登录 JSON · ' + account.name, JSON.stringify({ format: 'szu-court-session/v1', name: account.name,
    exportedAt: new Date().toISOString(), session: account.session }, null, 2)); }
function openAccount(id) { editable(); editAccount = id ?? null; $('#accountForm').reset(); $('#accountError').textContent = '';
  const account = store.state.accounts.find((a) => a.id === id); $('#accountTitle').textContent = account ? '更新登录' : '导入账号';
  $('#accountName').value = account?.name ?? ''; $('#accountDialog').showModal(); }
function openLogin(id) {
  editable(); loginAccount = id ?? null;
  const account = store.state.accounts.find((a) => a.id === id);
  $('#loginTitle').textContent = account ? '重新登录 · ' + account.name : '学校账号登录';
  $('#loginName').value = account?.name ?? '';
  $('#loginHint').textContent = account?.userId ? `请登录 ${account.user || account.name} 的学校账号。验证成功才替换登录；取消或登录错账号不会改动原记录。`
    : '将打开学校登录页。进入场馆页面后，请核对账号并点击“完成登录”；如需换号，点击“换号 / 重试”。验证通过后才保存。';
  $('#loginStatus').textContent = ''; $('#loginError').textContent = ''; $('#loginDialog').showModal();
}
async function verifyWithSchoolLogin(account) {
  try { return await verifyAccount(store, device, account); }
  catch (error) {
    if (!(error instanceof SessionExpiredError) || !native) throw error;
    toast('场馆登录已失效，正在尝试使用学校登录窗口恢复');
    const captured = await device.login();
    const updated = await saveSchoolLogin(store, captured, { accountId: account.id,
      name: account.name, transport: nativeTransport(device), confirmIdentity: (identity) => confirm(`识别到 ${identity.name}（学号尾号 ${String(identity.id).slice(-4)}），确认绑定到此用户？`) });
    return { id: updated.userId, name: updated.user };
  }
}

document.querySelectorAll('[data-tab]').forEach((el) => el.onclick = () => tab(el.dataset.tab));
document.querySelectorAll('[data-close]').forEach((el) => el.onclick = () => { $('#' + el.dataset.close + 'Dialog').close(); });
$('#planDialog').addEventListener('close', cancelCatalog);
$('#newPlan').onclick = action(() => openPlan()); $('#newAccount').onclick = action(() => openAccount());
$('#schoolLogin').onclick = action(() => openLogin());
$('#loginDialog').addEventListener('cancel', (event) => { if (authBusy) event.preventDefault(); });
$('#confirmDialog').addEventListener('cancel', (event) => { if (authBusy) event.preventDefault(); });
$('#openSchoolLogin').onclick = action(async () => {
  editable(); const accountId = loginAccount; const name = $('#loginName').value.trim();
  authBusy = true; render(); $('#loginError').textContent = ''; $('#loginStatus').textContent = '请在学校窗口完成登录…';
  $('#loginDialog').querySelectorAll('button, input').forEach((el) => el.disabled = true);
  try {
    const captured = await device.login();
    $('#loginStatus').textContent = '已获取 Cookie，正在核对学校身份和预约接口…';
    const account = await saveSchoolLogin(store, captured, { accountId, name, transport: nativeTransport(device), confirmIdentity: (identity) => confirm(`识别到 ${identity.name}（学号尾号 ${String(identity.id).slice(-4)}），确认绑定到此用户？`) });
    $('#loginDialog').close(); tab(store.state.plans.length ? 'accounts' : 'plans'); toast('已连接：' + account.user);
  } catch (error) { $('#loginStatus').textContent = ''; throw error; }
  finally { authBusy = false; $('#loginDialog').querySelectorAll('button, input').forEach((el) => el.disabled = false); render(); }
}, '#loginError');
$('#plans').onchange = (event) => { const id = event.target.dataset.select; if (!id) return; event.target.checked ? selected.add(id) : selected.delete(id); render(); };
$('#plans').onclick = action(async (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  button.closest('.more-actions')?.removeAttribute('open');
  const copy = event.target.closest('[data-copy]'); if (copy) return openPlan(null, repeatPlan(store.state.plans.find((p) => p.id === copy.dataset.copy)));
  const start = event.target.closest('[data-start]'); if (start) return showRunConfirmation([store.state.plans.find((p) => p.id === start.dataset.start)]);
  if (event.target.closest('[data-results]')) { tab('results'); return; }
  const login = event.target.closest('[data-login]'); if (login) { tab('accounts'); toast('原账号已删除，请连接账号并在方案中重新选择'); return; }
  const empty = event.target.closest('[data-empty]'); if (empty) { if (empty.dataset.empty === 'new') openPlan(); else { planFilter = 'all'; planQuery = ''; $('#planSearch').value = ''; render(); } return; }
  const edit = event.target.closest('[data-edit]'), del = event.target.closest('[data-delete]');
  const review = event.target.closest('[data-review]'); if (review) await reviewPlan(review.dataset.review);
  if (edit) openPlan(edit.dataset.edit);
  if (del) { editable(); if (!confirm('删除此方案？已保存的执行记录不受影响。')) return;
    const deletingPlan = store.state.plans.find((plan) => plan.id === del.dataset.delete);
    if (store.state.runs.some((run) => pendingMobileRequests(run).some((request) => request.planId === del.dataset.delete
      || request.accountId === deletingPlan.accountId && request.date === deletingPlan.date
        && (!request.project || request.project === deletingPlan.project)))) throw new Error('此账号、日期和项目仍有请求待确认，请先核对后再删除方案');
    await saveChange({ plans: store.state.plans.filter((p) => p.id !== del.dataset.delete) }); selected.delete(del.dataset.delete); render(); }
});
$('#sequence').onclick = (event) => { const b = event.target.closest('[data-move]'); if (!b || b.disabled) return; const i = Number(b.dataset.move), next = i + Number(b.dataset.step); [choices.courts[i], choices.courts[next]] = [choices.courts[next], choices.courts[i]]; renderChoices(); };
document.querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => { $('#interval').value = b.dataset.preset === 'release' ? '0.1' : '30'; $('#duration').value = b.dataset.preset === 'release' ? '2' : '120'; });
$('#planProject').onchange = () => { choices.times = []; choices.courts = []; choices.labels = {}; $('#sameCourt').checked = $('#planProject').value === 'volleyball'; loadCached(); };
$('#planAccount').onchange = () => loadCached();
$('#planDate').onchange = () => loadCached();
$('#bookingGoal').onchange = () => renderChoices();
$('#loadCatalog').onclick = action(async () => {
  editable(); cancelCatalog(); const controller = catalogController = new AbortController();
  const token = ++catalogToken; const account = store.state.accounts.find((a) => a.id === $('#planAccount').value); const project = $('#planProject').value;
  $('#loadCatalog').disabled = true; $('#planError').textContent = '';
  try { const catalog = await readCatalog(store, device, account, project, $('#planDate').value, { signal: controller.signal }); if (token === catalogToken) { choices.catalog = catalog; renderChoices(); } }
  catch (error) { if (token === catalogToken) throw error; }
  finally { if (catalogController === controller) { catalogController = null; $('#loadCatalog').disabled = false; } }
}, '#planError');
$('#times').onclick = (event) => { const time = event.target.closest('[data-time]')?.dataset.time; if (!time) return;
  choices.times = choices.times.includes(time) ? choices.times.filter((t) => t !== time) : [...choices.times, time]; renderChoices(); };
$('#addTime').onclick = action(() => { const time = $('#timeStart').value + '-' + $('#timeEnd').value; splitTimeSlot(time);
  if (!choices.times.includes(time)) choices.times.push(time); renderChoices(); }, '#planError');
$('#courts').onclick = (event) => { const id = event.target.closest('[data-court]')?.dataset.court; if (!id) return;
  choices.courts = choices.courts.includes(id) ? choices.courts.filter((c) => c !== id) : [...choices.courts.filter((c) => c !== '*'), id]; renderChoices(); };
$('#allCourts').onclick = () => { choices.courts = ['*']; renderChoices(); }; $('#clearCourts').onclick = () => { choices.courts = []; renderChoices(); };
$('#planForm').onsubmit = action(async (event) => {
  event.preventDefault(); editable();
  const plan = validatePlan({ id: editPlan ?? crypto.randomUUID(), name: $('#planName').value.trim(), accountId: $('#planAccount').value,
    bookingGoal: $('#bookingGoal').value, project: $('#planProject').value, date: $('#planDate').value, times: [...choices.times].sort(), courts: [...choices.courts],
    courtLabels: { ...choices.labels }, includeOtherCourts: $('#includeOtherCourts').checked, preferSameCourt: $('#sameCourt').checked, intervalMs: Number($('#interval').value) * 1000, durationMs: Number($('#duration').value) * 60000 });
  const previousPlan = store.state.plans.find((p) => p.id === plan.id);
  if (previousPlan && previousPlan.date === plan.date && previousPlan.project === plan.project && previousPlan.accountId === plan.accountId) plan.sameCourtAnchor = previousPlan.sameCourtAnchor;
  const plans = previousPlan ? store.state.plans.map((p) => p.id === plan.id ? plan : p) : [...store.state.plans, plan];
  await saveChange({ plans }); $('#planDialog').close(); render(); toast('方案已保存，开始前会请你确认');
}, '#planError');
$('#sessionFile').onchange = action(async () => { const file = $('#sessionFile').files[0]; if (!file) return;
  if (file.size > 2000000) throw new Error('文件过大'); $('#sessionText').value = await file.text(); }, '#accountError');
$('#accountForm').onsubmit = action(async (event) => {
  event.preventDefault(); editable(); const session = parseSessionText($('#sessionText').value);
  const previous = store.state.accounts.find((a) => a.id === editAccount);
  const account = { ...previous, id: previous?.id ?? crypto.randomUUID(), name: $('#accountName').value.trim(), session, verifiedAt: null };
  if (!account.name) throw new Error('请填写账号备注');
  authBusy = true; render();
  try {
    if (previous?.userId) { const { api, client } = createConnection(store, device, account);
      try { const identity = await api.getIdentity();
        if (identity.id !== previous.userId) throw new Error('这不是原来的学校账号，请新增用户后导入');
      } finally { await client.flush(); }
    }
    await store.update({ accounts: previous ? store.state.accounts.map((a) => a.id === account.id ? account : a) : [...store.state.accounts, account] });
    $('#accountDialog').close(); if (!store.state.plans.length) tab('plans'); toast('登录已保存，执行前会核对身份');
  } finally { authBusy = false; render(); }
}, '#accountError');
$('#accounts').onclick = action(async (event) => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.export) return exportAccount(button.dataset.export);
  editable();
  if (button.dataset.relogin) return openLogin(button.dataset.relogin);
  if (button.dataset.update) return openAccount(button.dataset.update);
  if (button.dataset.verify) { authBusy = true; render();
    try { const identity = await verifyWithSchoolLogin(store.state.accounts.find((a) => a.id === button.dataset.verify)); toast('验证成功：' + identity.name); }
    finally { authBusy = false; render(); } }
  if (button.dataset.remove) { const id = button.dataset.remove;
    if (store.state.plans.some((p) => p.accountId === id)) throw new Error('请先删除或修改使用此账号的方案');
    if (store.state.runs.some((run) => pendingMobileRequests(run).some((request) => request.accountId === id))) throw new Error('此账号仍有请求待确认，请先核对后再删除账号');
    if (!confirm('删除此账号及其登录？学校预约不会取消。')) return;
    await saveChange({ accounts: store.state.accounts.filter((a) => a.id !== id) }); }
});
$('#copyText').onclick = action(async () => { await device.copy({ text: $('#exportText').value }); toast('完整内容已复制'); });
function showRunConfirmation(plans) {
  editable(); if (!plans.length) throw new Error('请先选择方案');
  plans.forEach(validatePlan); $('#confirmError').textContent = '';
  const prior = store.state.runs.filter((r) => r.finishedAt && plans.some((p) => {
    const sameAccount = (id) => id === p.accountId || (store.state.accounts.find((a) => a.id === id)?.userId && store.state.accounts.find((a) => a.id === id)?.userId === store.state.accounts.find((a) => a.id === p.accountId)?.userId);
    const matching = (record) => {
      const originals = r.plans.filter((old) => record.planId ? old.id === record.planId : old.name === record.plan || old.name === record.name);
      return sameAccount(record.accountId) && record.date === p.date && p.times.includes(record.time)
        && (!originals.length || originals.some((old) => old.project === p.project));
    };
    return pendingMobileRequests(r).some(matching) || r.successes.some(matching);
  }));
  if (prior.length && !confirm('所选账号和日期已有成功或结果待确认的记录。请先到学校“我的预约”核对，并移除已约时段，避免重复提交。确认仍要继续？')) return;
  $('#confirmPlans').textContent = plans.map((p) => `${p.name} · ${accountName(p.accountId)}\n使用场地：${p.date} ${p.times.join('、')} · ${GOAL_LABELS[p.bookingGoal ?? (new Set(p.times).size === 1 ? 'one' : 'two')]}\n放号：${format(bookingReleaseAt(p.date))}（北京时间）`).join('\n\n');
  const released = plans.some((p) => bookingReleaseAt(p.date) <= Date.now());
  if (plans.some((p) => shanghaiDate(bookingReleaseAt(p.date)) > shanghaiDate())) throw new Error('请在放号当天登录并启动；方案已保存，无需提前守候');
  document.querySelector('input[name=mode][value=release]').disabled = released;
  document.querySelector('input[name=mode][value=now]').disabled = plans.some((p) => bookingReleaseAt(p.date) > Date.now());
  document.querySelector('input[name=mode][value=auto]').checked = true;
  confirmSelection = plans.map((p) => p.id);
  $('#confirmDialog').showModal();
}
$('#begin').onclick = action(() => showRunConfirmation(store.state.plans.filter((p) => selected.has(p.id))));
$('#confirmStart').onclick = action(async () => {
  editable();
  if (!native) throw new Error('网页预览不能执行，请安装 APK');
  const plans = store.state.plans.filter((p) => confirmSelection.includes(p.id)); const mode = document.querySelector('input[name=mode]:checked').value;
  const confirmedAt = Date.now();
  cancelCatalog();
  archivedRuns = []; archiveCursor = ''; archiveHasMore = true;
  $('#toast').classList.remove('show');
  const work = execution.start(plans, mode, { confirmedAt });
  $('#confirmDialog').close(); tab('results'); render();
  try { await work; } catch (error) { toast('执行未正常保存：' + error.message); }
  finally { render(); }
}, '#confirmError');
$('#stop').onclick = () => execution.stop();
$('#runs').onclick = action(async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.disabled) return;
  if (button.dataset.runReview) {
    const run = historyRuns().find((record) => record.id === button.dataset.runReview);
    const plan = run.plans.find((record) => record.id === button.dataset.reviewPlan);
    return reviewPlan(plan.id, structuredClone(plan));
  }
    if (button.dataset.runExport) { const run = historyRuns().find((r) => r.id === button.dataset.runExport); showText('诊断记录 JSON', JSON.stringify(exportDiagnostics(run), null, 2)); }
  if (button.dataset.runDelete) { editable(); if (!confirm('删除这次本地记录？学校预约不会取消。')) return;
    if (pendingMobileRequests(store.state.runs.find((run) => run.id === button.dataset.runDelete)).length) throw new Error('这次执行仍有请求待确认，请先核对后再删除记录');
    await saveChange({ runs: store.state.runs.filter((r) => r.id !== button.dataset.runDelete) }); }
});
$('#runs').addEventListener('toggle', (event) => {
  if (!event.target.matches('details[data-log]') || !event.target.open) return;
  const run = historyRuns().find((record) => record.id === event.target.dataset.log);
  if (run) event.target.querySelector('.run-logs').textContent = run.logs.map((log) => `${format(log.time)} ${log.level} ${log.message}${log.details ? ' ' + JSON.stringify(log.details) : ''}`).join('\n');
}, true);
$('#loadHistory').onclick = action(async () => {
  editable(); authBusy = true; render();
  try {
    const result = await device.readRunArchives({ before: archiveCursor, limit: 20 });
    archivedRuns.push(...result.runs); archiveCursor = result.cursor; archiveHasMore = result.hasMore;
  } finally { authBusy = false; render(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) execution.stop('background'); });
window.addEventListener('pagehide', () => execution.stop('background'));
async function planPrimary({ plan, experience: ex }) {
  if (['active', 'done'].includes(ex.phase)) { tab('results'); return; }
  if (ex.phase === 'login') { tab('accounts'); return; }
  if (ex.phase === 'attention') { await reviewPlan(plan.id); return; }
  if (ex.phase === 'expired') { openPlan(null, repeatPlan(plan)); return; }
  if (ex.phase === 'future') { openPlan(plan.id); return; }
  showRunConfirmation([store.state.plans.find((p) => p.id === plan.id)]);
}
$('#planSearch').oninput = () => { planQuery = $('#planSearch').value; render(); };
document.querySelectorAll('[data-filter]').forEach((button) => button.onclick = () => { planFilter = button.dataset.filter; render(); });
async function init() {
  await store.load(); ready = true;
  $('#runtime').textContent = native ? '仅前台执行' : '网页预览';
  await device.addListener('foreground', ({ active }) => { foreground = active; if (!active) execution.stop('background'); });
  tab(currentTab); render(); setInterval(() => { if (!execution.active) render(); else renderProgress(); }, 1000);
}
init().catch((error) => { $('#fatal').hidden = false; $('#fatal').textContent = error.message;
  document.querySelectorAll('button').forEach((button) => button.disabled = true); });
