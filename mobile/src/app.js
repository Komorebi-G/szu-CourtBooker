import { installMenus, planExperience, visiblePlans, repeatPlan, friendlyDate, selectionSummary, selectedBookingGoal, bookingTitle, matchingMobileRun } from '../../shared/experience.js';
import { device, native, nativeTransport } from './device.js';
import { saveSchoolLogin } from './login.js';
import { MobileStore, pendingMobileRequests, reviewedMobileRuns } from './store.js';
import { ForegroundExecution, validatePlan } from './execution.js';
import { mobileTaskExperience } from './task-experience.js';
import { createConnection, verifyAccount, readCatalog } from './school.js';
import { PROJECTS } from '../../shared/projects.js';
import { parseSessionText } from '../../shared/session-format.js';
import { shanghaiDate, addDays, splitTimeSlot } from '../../shared/utils.js';
import { bookingReleaseAt } from '../../shared/runner.js';
import { SessionExpiredError } from '../../shared/errors.js';
import { reviewBookings } from '../../shared/booking-review.js';
import { resolveTargets } from '../../shared/planner.js';
import { targetFor } from './execution.js';
import { APP_URL } from '../../shared/constants.js';
import { exportDiagnostics } from '../../shared/diagnostics.js';

installMenus();
const $ = (s) => document.querySelector(s);
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const format = (epoch) => new Date(epoch).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const labels = { preparing: '准备中', waiting: '等待放号', booking: '预约中', stopping: '正在停止', stopped: '已停止',
  interrupted: '已中断', success: '已完成', partial: '部分成功', error: '预约未完成', missed: '已错过', limited: '上限已达 · 未预约', expired: '时段已过期', no_result: '未约到' };
const store = new MobileStore(device);
const selected = new Set();
let ready = false, foreground = !document.hidden, editPlan = null, editAccount = null, catalogToken = 0, currentTab = 'plans';
let choices = { times: [], courts: [], labels: {}, catalog: null };
let loginAccount = null, authBusy = false, notifiedRun = null, catalogController = null, refreshingRun = null;
const accountChecks = new Map();
let catalogLoading = false, catalogError = '', batchMode = false, createAfterLogin = false;
let textBusy = false;
function cancelCatalog() { catalogToken++; catalogController?.abort(); catalogController = null; catalogLoading = false; $('#loadCatalog').disabled = false; }
let planFilter = 'recent', planQuery = '', confirmSelection = [];
let archivedRuns = [], archiveCursor = '', archiveHasMore = true;
const historyRuns = () => [...store.state.runs, ...archivedRuns.filter((old) => !store.state.runs.some((run) => run.id === old.id))];
const planContext = (plan) => {
  const run = matchingMobileRun(plan, store.state.runs);
  return { plan: { ...plan, projectLabel: PROJECTS.find((p) => p.id === plan.project)?.label }, run,
    experience: mobileTaskExperience(plan, { account: store.state.accounts.find((a) => a.id === plan.accountId), run }) };
};
const execution = new ForegroundExecution({ store, device, createApi: (account, token, options) => createConnection(store, device, account, token, options),
  changed: () => render(), isForeground: () => foreground && !document.hidden });
const accountName = (id) => store.state.accounts.find((a) => a.id === id)?.name ?? '账号已删除';
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4500); }
function editable() { if (!ready) throw new Error('数据尚未加载'); if (execution.active) throw new Error('请先停止当前执行，再修改预约或账号'); if (authBusy) throw new Error('正在处理，请稍候'); }
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
  $('#batchBar').hidden = name !== 'plans' || !batchMode || !selected.size;
  document.querySelectorAll('[data-tab]').forEach((el) => el.setAttribute('aria-current', el.dataset.tab === name ? 'page' : 'false'));
}
function showResults(planId) {
  tab('results');
  const plan = store.state.plans.find((p) => p.id === planId);
  const run = plan && matchingMobileRun(plan, store.state.runs);
  if (run) $(`#runs [data-run="${CSS.escape(run.id)}"]`)?.scrollIntoView({ block: 'start' });
}
const loginCancelled = (error) => /取消/.test(error?.message ?? '');
const pendingPlans = (run) => run.plans.filter((plan) => pendingMobileRequests(run).some((request) =>
  request.planId ? request.planId === plan.id : request.plan ? request.plan === plan.name : run.plans.length === 1));
const absentActions = (run) => run.finishedAt && pendingMobileRequests(run).length ? pendingPlans(run)
  .map((plan) => `<button class="text-button" data-run-absent="${escape(run.id)}" data-absent-plan="${escape(plan.id)}" ${execution.active || authBusy ? 'disabled' : ''}>学校确认未预约${run.plans.length > 1 ? ' · ' + escape(plan.name) : ''}</button>`).join('') : '';
function courtDescription(plan) { return plan.courts.includes('*') ? '按学校顺序尝试全部场地'
  : plan.courts.map((id, i) => `${i + 1}. ${plan.courtLabels?.[id] ?? id}`).join(' → ')
    + (plan.includeOtherCourts ? ' → 其余场地（学校顺序）' : '（仅尝试已选场地）'); }
function render() {
  if (!ready) return;
  if (!execution.active && execution.current?.finishedAt && notifiedRun !== execution.current.id) {
    const run = execution.current, added = run.successes.filter((s) => !s.reused).length;
    const next = pendingMobileRequests(run).length ? '有请求结果待确认，请核对学校“我的预约”。'
      : run.successes.length ? '请到学校查看预约 / 付款。'
        : run.error || run.items.find((item) => item.error)?.error || '未新增预约，可以重新尝试。';
    notifiedRun = run.id; toast(`本次执行：${labels[run.status]}，新预约 ${added} 段。${next}`);
  }
  const contexts = store.state.plans.map(planContext);
  const eligible = new Set(contexts.filter((c) => c.experience.canStart).map((c) => c.plan.id));
  if (!execution.active) for (const id of selected) if (!eligible.has(id)) selected.delete(id);
  $('#newPlan').disabled = $('#newAccount').disabled = $('#schoolLogin').disabled = execution.active || authBusy;
  $('#accountForm button[type="submit"]').disabled = authBusy;
  $('#savePlanButton').disabled = authBusy || $('#planDialog').open && !selectionSummary(choices.times, choices.courts, $('#bookingGoal').value).valid;
  $('#batchSelect').disabled = execution.active || authBusy;
  $('#begin').disabled = execution.active || authBusy || selected.size === 0;
  $('#stop').hidden = !execution.active;
  $('#saveText').disabled = execution.active || textBusy;
  $('#selectedCount').textContent = `已选 ${selected.size} 个预约`;
  $('#batchBar').hidden = currentTab !== 'plans' || !batchMode || !selected.size;
  $('#batchSelect').hidden = batchMode; $('#endBatch').hidden = !batchMode;
  const signature = JSON.stringify([store.state.plans, store.state.accounts.map((a) => [a.id, a.name, a.user, a.verifiedAt]), [...accountChecks], [...selected], batchMode, execution.active, authBusy, contexts.map((c) => c.experience), planFilter, planQuery]);
  if (render.signature !== signature) {
    render.signature = signature;
    const next = visiblePlans(contexts)[0], shown = visiblePlans(contexts, { filter: planFilter, query: planQuery });
    const attention = contexts.filter((c) => c.experience.pending);
    const connected = store.state.accounts.length > 0, hasPlans = contexts.length > 0;
    const onlyExpired = hasPlans && contexts.every((context) => context.experience.expired);
    const previous = onlyExpired ? [...contexts].sort((a, b) => b.plan.date.localeCompare(a.plan.date))[0] : null;
    $('.mobile-overview').hidden = !execution.active && connected && hasPlans && !attention.length && !onlyExpired;
    $('#newPlan').hidden = !hasPlans;
    $('#planTools').hidden = !hasPlans || contexts.length < 2 && !onlyExpired && planFilter === 'recent' && !planQuery && !batchMode;
    $('#plans').hidden = !hasPlans || onlyExpired && planFilter === 'recent' && !planQuery;
    $('#overviewTitle').textContent = execution.active ? '预约进行中' : !connected ? '先登录学校账号' : attention.length ? '有预约结果未确认' : !hasPlans ? '选择时间和场地' : onlyExpired ? '之前的预约已过期' : '预约';
    $('#overviewHint').textContent = execution.active ? '保持前台与亮屏，在记录页查看进度。' : !connected ? '使用学校账号登录后，选择运动、日期和时段。' : attention.length ? '在记录中查看上次请求的结果。' : !hasPlans ? '确认后开始预约；尚未放号时会等到 12:30。' : onlyExpired ? '可沿用之前的场地与时段，选择新日期。' : '';
    const overviewAction = $('#overviewAction'); overviewAction.hidden = false;
    overviewAction.textContent = execution.active ? '查看进度' : !connected ? '登录学校账号' : attention.length ? '查看结果' : !hasPlans ? '新建预约' : onlyExpired ? '重新选日期' : next?.experience.canStart ? next.experience.action : '查看预约';
    overviewAction.disabled = authBusy;
    overviewAction.onclick = action(async () => {
      if (execution.active) tab('results'); else if (!connected) openLogin(); else if (attention.length) showResults(attention[0].plan.id); else if (!hasPlans) openPlan(); else if (onlyExpired) openPlan(null, repeatPlan(previous.plan)); else if (next?.experience.canStart) await planPrimary(next); else { planQuery = ''; $('#planSearch').value = ''; planFilter = 'all'; render(); $('#plans').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    });
    document.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === planFilter)));
    $('#plans').innerHTML = shown.length ? shown.map(({ plan: p, experience: ex }) => {
      const primary = ex.primary, title = bookingTitle(p, p.projectLabel), actionLabel = ex.action;
      return `<article class="task-card phase-${ex.phase}" data-plan="${escape(p.id)}">
        <div class="task-head"><div class="plan-select">${batchMode ? `<input type="checkbox" aria-label="选择预约 ${escape(p.name)}" data-select="${escape(p.id)}" ${selected.has(p.id) ? 'checked' : ''} ${!ex.canStart || execution.active || authBusy ? 'disabled' : ''}>` : ''}<div><div class="plan-title-row"><h3>${escape(title)}</h3>${title !== p.projectLabel ? `<span class="project-tag">${escape(p.projectLabel)}</span>` : ''}</div><p class="task-date">${escape(friendlyDate(p.date))}${store.state.accounts.length > 1 ? ' · ' + escape(accountName(p.accountId)) : ''}</p></div></div><span class="badge ${ex.phase}">${escape(ex.badge)}</span></div>
        <div class="task-content"><div class="chips">${p.times.map((t) => `<span class="chip">${escape(t)}</span>`).join('')}</div><p class="plan-brief">${p.courts.includes('*') ? '不限场地' : escape(p.courts.map((court) => p.courtLabels?.[court] ?? court).join(' → '))}</p></div>
        <p class="next-hint">${escape(ex.hint)}</p>
        <div class="task-actions"><details class="more-actions"><summary aria-label="修改或删除预约">···</summary><div><button class="text-button" data-edit="${escape(p.id)}" ${execution.active || authBusy ? 'disabled' : ''}>修改预约</button>${ex.phase !== 'expired' ? `<button class="text-button" data-copy="${escape(p.id)}" ${execution.active || authBusy ? 'disabled' : ''}>换日期再约</button>` : ''}<button class="text-button danger-text" data-delete="${escape(p.id)}" ${execution.active || authBusy ? 'disabled' : ''}>删除预约</button></div></details>
        <button class="primary plan-primary" data-${primary}="${escape(p.id)}" ${ex.phase === 'future' || (execution.active && ex.phase !== 'active') || authBusy ? 'disabled' : ''}>${escape(actionLabel)}</button></div></article>`;
    }).join('') : `<div class="empty"><h3>${!contexts.length ? '暂无预约' : '没有匹配的预约'}</h3><button class="secondary" data-empty="${!contexts.length ? 'new' : 'all'}">${!contexts.length ? '新建预约' : '查看全部预约'}</button></div>`;
    $('#schoolLogin').textContent = store.state.accounts.length ? '添加学校账号' : '登录学校账号';
    $('#accounts').innerHTML = store.state.accounts.length ? store.state.accounts.map((a) => {
      const check = accountChecks.get(a.id), checking = ['checking', 'recovering'].includes(check?.state);
      return `<article class="task-card" data-account="${escape(a.id)}"><h3>${escape(a.user || a.name)}</h3><p class="task-date">${a.verifiedAt ? '上次登录验证：' + escape(format(a.verifiedAt)) : '登录已保存，预约时会重新验证'}</p>${check ? `<p class="account-check-status ${check.state === 'error' ? 'task-error' : 'field-help'}" role="status">${escape(check.message)}</p>` : ''}<div class="task-actions">
      <button class="secondary account-check" data-verify="${a.id}" aria-busy="${checking}" ${execution.active || authBusy ? 'disabled' : ''}>${check?.state === 'recovering' ? '恢复中…' : checking ? '检查中…' : '检查登录'}</button>
      <details class="more-actions"><summary aria-label="账号操作">···</summary><div><button class="text-button" data-relogin="${a.id}" ${execution.active || authBusy ? 'disabled' : ''}>重新登录</button><button class="text-button" data-export="${a.id}">导出登录文件</button><button class="text-button" data-update="${a.id}" ${execution.active || authBusy ? 'disabled' : ''}>导入更新</button><button class="text-button danger-text" data-remove="${a.id}" ${execution.active || authBusy ? 'disabled' : ''}>删除账号</button></div></details></div></article>`;
    }).join('') : '<div class="empty">尚未登录学校账号</div>';
  }
  const attentionCount = store.state.runs.filter((r) => !r.finishedAt || pendingMobileRequests(r).length).length;
  $('#resultsBadge').hidden = !attentionCount; $('#resultsBadge').textContent = attentionCount;
  renderProgress();
  const shownRuns = historyRuns();
  $('#loadHistory').hidden = execution.active || !(store.state.archivedRunCount && archiveHasMore);
  $('#loadHistory').disabled = authBusy;
  const runSignature = JSON.stringify([execution.active, authBusy, refreshingRun, shownRuns.map((run) => [run.id, run.status, run.reviewedOutcome, run.error, run.finishedAt,
    run.successes, run.pendingRequests, run.inFlight, run.items, run.logs.length, run.logs.at(-1)])]);
  if (render.runSignature !== runSignature) {
    render.runSignature = runSignature;
    const expanded = new Set([...document.querySelectorAll('[data-log][open]')].map((el) => el.dataset.log));
    $('#runs').innerHTML = shownRuns.length ? shownRuns.map((run) => `<article class="task-card" data-run="${escape(run.id)}">
      <div class="task-head"><h3>${escape(run.plans.map((p) => bookingTitle(p, p.projectLabel ?? PROJECTS.find((project) => project.id === p.project)?.label ?? '预约')).join('、'))}</h3><span class="badge ${escape(run.reviewedOutcome ?? run.status)}">${run.reviewedOutcome === 'success' ? '学校已确认' : run.reviewedOutcome === 'no_result' ? '已确认未预约' : labels[run.reviewedOutcome ?? run.status] ?? run.status}</span></div>
      <p class="run-meta">${format(run.startedAt)}</p>
      ${run.error && !(run.reviewedOutcome && !pendingMobileRequests(run).length) ? `<p class="task-error">${run.reviewedOutcome ? '执行时：' : ''}${escape(run.error)}</p>` : ''}
      ${pendingMobileRequests(run).map((request) => `<p class="${run.finishedAt || request.state === 'unknown' ? 'task-error' : 'run-meta'}">${run.finishedAt || request.state === 'unknown' ? '待核对' : request.state === 'prepared' ? '已准备' : '请求已发出，等待学校响应'}：${escape(request.plan)} ${escape(request.time)} ${escape(request.court)}</p>`).join('')}
      ${run.successes.map((s) => `<p class="run-result">✓ ${escape(accountName(s.accountId))} · ${escape(s.date)}<br>${escape(s.time)} · ${escape(s.court)}${s.confirmed ? '（学校已确认）' : s.reused ? (s.school ? '（学校已有，未重复提交）' : '（同批次已约，未重复提交）') : ''}${s.orderId ? '<br>订单：' + escape(s.orderId) : ''}</p>`).join('') || `<p class="run-meta">${run.finishedAt ? pendingMobileRequests(run).length ? '预约结果待确认' : run.reviewedOutcome === 'success' || ['success', 'partial'].includes(run.status) ? '预约结果已保存' : '本次未约到场地' : run.status === 'waiting' ? '等待开放预约' : '正在预约'}</p>`}
      ${run.successes.length || pendingMobileRequests(run).length || run.status === 'limited' ? `<a href="${APP_URL.replace('#/sportVenue', '#/myBooking')}" target="_blank" rel="noopener noreferrer">${run.successes.length ? '查看学校预约 / 付款' : '查看学校预约'}</a>` : ''}${run.items.map((i) => `<p class="run-meta">${escape(i.name)}：${i.reviewedOutcome === 'success' ? '学校已确认' : labels[i.reviewedOutcome ?? i.status] ?? i.status}${i.limited && i.status === 'partial' ? ' · 已达两时段上限' : ''}${i.error && !i.reviewedOutcome ? ' · ' + escape(i.error) : ''}</p>${(i.reviewedOutcome === 'no_result' ? [] : i.slots ?? []).filter((slot) => slot.status !== 'success' && !run.successes.some((success) => success.planId === i.id && success.time === slot.time)).map((slot) => `<p class="run-meta">${escape(slot.time)}：${escape({ success: '已成功', expired: '已过期', limited: '已达上限', goal_reached: '目标已达，未尝试', ineligible: '不符合连续目标，未尝试', conflict: '与本批次已约场地冲突', unfilled: '未约到', error: '发生错误' }[slot.status] ?? slot.status)}${slot.lastMessage ? ' · ' + escape(slot.lastMessage) : ''}</p>`).join('')}`).join('')}
      <details data-log="${run.id}" ${expanded.has(run.id) ? 'open' : ''}><summary>详细日志（${run.logs.length} 条）</summary><div class="run-logs">${expanded.has(run.id) ? run.logs.map((l) => escape(`${format(l.time)} ${l.level} ${l.message}${l.details ? ' ' + JSON.stringify(l.details) : ''}`)).join('\n') : ''}</div></details>
      <div class="task-actions">${run.finishedAt && pendingMobileRequests(run).length ? pendingPlans(run).map((plan) => `<button class="text-button" data-run-refresh="${run.id}" data-refresh-plan="${escape(plan.id)}" ${execution.active || authBusy ? 'disabled' : ''}>${refreshingRun === run.id ? '刷新中…' : '刷新结果'}${run.plans.length > 1 ? ' · ' + escape(plan.name) : ''}</button>`).join('') : ''}<details class="more-actions"><summary aria-label="预约记录操作">···</summary><div><button class="text-button" data-run-export="${run.id}">导出记录</button>${absentActions(run)}${run.finishedAt && store.state.runs.some((hot) => hot.id === run.id) ? `<button class="text-button danger-text" data-run-delete="${run.id}" ${execution.active || authBusy ? 'disabled' : ''}>删除记录</button>` : ''}</div></details></div></article>`).join('') : '<div class="empty">暂无预约记录</div>';
  }
}
function renderProgress() {
  $('#liveStatus').hidden = !execution.active;
  if (!execution.active) return;
  const run = execution.current;
  const text = run.items.map((item) => {
    if (item.status === 'waiting') { const left = Math.max(0, Math.ceil((item.releaseAt - Date.now()) / 1000));
      return `${item.name}：倒计时 ${Math.floor(left / 3600)}:${String(Math.floor(left / 60) % 60).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`; }
    const activity = item.status === 'booking' && (item.activity === 'cooldown'
      ? `学校限制请求，等待重试${item.retryAt > Date.now() ? `（约 ${Math.ceil((item.retryAt - Date.now()) / 1000)} 秒）` : ''}` : item.activityMessage);
    return `${item.name}：${activity || labels[item.status] || item.status}`;
  }).join('\n');
  $('#liveStatus').textContent = (run.status === 'stopping' ? '正在停止，等待已发出的请求返回。\n' : '执行中保持亮屏，请勿锁屏或切换 App。\n') + text;
}
function loadCached() {
  cancelCatalog();
  choices.catalog = store.state.catalogs[$('#planAccount').value + ':' + $('#planProject').value] ?? null;
  renderChoices();
}
function renderChoices() {
  if (!choices.customGoal && !choices.preserveGoal) $('#bookingGoal').value = selectedBookingGoal(choices.times);
  $('#bookingGoalHint').hidden = $('#bookingGoal').value !== 'consecutive';
  const date = $('#planDate').value;
  if (date) { const experience = planExperience({ date, times: choices.times }, { account: store.state.accounts.find((a) => a.id === $('#planAccount').value) });
    $('#planSchedule').textContent = experience.releaseAt <= Date.now() ? '已开放，可以立即预约' : `${friendlyDate(shanghaiDate(experience.releaseAt))} 12:30 开放预约`; }
  const summary = selectionSummary(choices.times, choices.courts, $('#bookingGoal').value);
  const validationError = !summary.valid && choices.times.length ? summary.text : '';
  if (validationError || $('#planError').textContent === renderChoices.validationError) $('#planError').textContent = validationError;
  renderChoices.validationError = validationError;
  $('#selectionSummary').textContent = summary.valid ? `已选 ${choices.times.length} 个时段 · ${choices.courts.includes('*') ? '不限场地' : choices.courts.length + ' 个场地'}` : summary.text;
  $('#selectionSummary').classList.toggle('complete', summary.valid);
  $('#savePlanButton').disabled = authBusy || !summary.valid;
  $('#savePlanButton').textContent = editPlan ? '保存修改' : date && shanghaiDate(bookingReleaseAt(date)) > shanghaiDate() ? '保存预约' : '下一步';
  $('#allCourts').setAttribute('aria-pressed', String(choices.courts.includes('*')));
  const catalog = choices.catalog;
  $('#catalogNote').textContent = catalogLoading ? '正在加载可选时段与场地…' : catalogError || (!catalog?.times.length ? '尚未加载时段' : '');
  $('#loadCatalog').hidden = catalogLoading || Boolean(catalog?.times.length && !catalogError);
  const times = [...new Set([...(catalog?.times ?? []), ...choices.times])].sort();
  $('#times').innerHTML = times.map((time) => `<button type="button" class="time-option ${choices.times.includes(time) ? 'selected' : ''}" data-time="${escape(time)}" aria-pressed="${choices.times.includes(time)}">${escape(time)}</button>`).join('');
  const courts = [...(catalog?.courts ?? [])];
  for (const id of choices.courts.filter((c) => c !== '*')) if (!courts.some((c) => c.id === id)) courts.push({ id, name: choices.labels[id] ?? '已保存场地' });
  $('#courts').innerHTML = courts.map((court) => { const n = choices.courts.indexOf(court.id); choices.labels[court.id] = court.name;
    return `<button type="button" class="court-card ${n >= 0 ? 'selected' : ''}" data-court="${escape(court.id)}" aria-pressed="${n >= 0}"><span class="court-order">${n >= 0 ? n + 1 : '+'}</span><span class="court-name">${escape(court.name)}</span></button>`; }).join('');
  $('#sequence').innerHTML = choices.courts.includes('*') ? '按学校顺序尝试全部场地' : choices.courts.map((id, i) => `<span class="order-chip">${i + 1}. ${escape(choices.labels[id] ?? id)}<button type="button" data-move="${i}" data-step="-1" aria-label="上移 ${escape(choices.labels[id] ?? id)}" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move="${i}" data-step="1" aria-label="下移 ${escape(choices.labels[id] ?? id)}" ${i === choices.courts.length - 1 ? 'disabled' : ''}>↓</button></span>`).join(' → ');
  $('#orderSettings').hidden = choices.courts.includes('*') || choices.courts.length < 2;
}
function openPlan(id, source = null) {
  editable();
  if (!store.state.accounts.length) { tab('accounts'); toast('请先登录或导入一个账号'); return; }
  const plan = source ?? store.state.plans.find((p) => p.id === id); editPlan = source ? null : plan?.id ?? null;
  $('#planForm').reset(); $('#planOptions').open = false; $('#orderSettings').open = false;
  $('#planError').textContent = ''; $('#planTitle').textContent = source ? '换日期再约' : plan ? '修改预约' : '新建预约';
  $('#planName').value = plan?.name ?? '';
  $('#planAccount').innerHTML = store.state.accounts.map((a) => `<option value="${a.id}">${escape(a.name)}</option>`).join('');
  $('#planAccount').value = plan?.accountId ?? store.state.accounts[0].id;
  $('#planAccountField').hidden = store.state.accounts.length === 1;
  $('#planProject').innerHTML = PROJECTS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  $('#planProject').value = plan?.project ?? 'badminton';
  const dates = Array.from({ length: 8 }, (_, i) => addDays(shanghaiDate(), i));
  $('#planDate').innerHTML = dates.map((d) => `<option value="${d}">${friendlyDate(d)}</option>`).join('');
  if (plan && !dates.includes(plan.date)) $('#planDate').insertAdjacentHTML('afterbegin', `<option value="${escape(plan.date)}">${escape(plan.date)} · 已过期，请选择新日期</option>`);
  $('#planDate').value = plan?.date ?? dates[1];
  $('#bookingGoal').value = plan?.bookingGoal ?? selectedBookingGoal(plan?.times ?? []);
  $('#sameCourt').checked = plan?.preferSameCourt ?? false;
  $('#includeOtherCourts').checked = plan?.includeOtherCourts ?? false;
  $('#interval').value = (plan?.intervalMs ?? 100) / 1000; $('#duration').value = (plan?.durationMs ?? 120000) / 60000;
  choices = { times: [...(plan?.times ?? [])], courts: [...(plan?.courts ?? ['*'])], labels: { ...plan?.courtLabels }, catalog: null, customGoal: false, preserveGoal: Boolean(plan) };
  catalogError = ''; loadCached(); $('#planDialog').showModal(); $('#planDialog').scrollTop = 0;
  if (native) void loadSchoolChoices();
}
async function refreshRunResults(runId, plan, { confirmAbsent = false } = {}) {
  editable(); cancelCatalog();
  const account = store.state.accounts.find((a) => a.id === plan.accountId);
  if (!native) throw new Error('网页预览不能连接学校，请在手机 App 中刷新结果');
  if (!account) throw new Error('预约账号已删除，请先连接账号');
  authBusy = true; refreshingRun = runId; render();
  try {
    const { api, client } = createConnection(store, device, account);
    let review;
    try {
      const identity = await api.getIdentity();
      if (account.userId && account.userId !== identity.id) throw new Error('学校身份不匹配，请更新登录');
      const target = resolveTargets({ targets: [targetFor(plan)] }, await api.getSportVenueData())[0];
      const matching = (run, record) => {
        const originals = run.plans.filter((p) => record.planId ? p.id === record.planId : p.name === record.plan || p.name === record.name);
        const accountId = record.accountId ?? (originals.length === 1 ? originals[0].accountId : null);
        return accountId === plan.accountId && (record.project ? record.project === plan.project
          : !originals.length || originals.some((old) => old.project === plan.project));
      };
      const pending = store.state.runs.flatMap((run) => pendingMobileRequests(run).filter((record) => matching(run, record)));
      review = reviewBookings({ plan, target, rows: await api.getAllBookings(), pending, now: Date.now() });
    } finally { await client.flush(); }
    const confirmedAbsentIds = new Set();
    if (confirmAbsent) {
      const run = store.state.runs.find((run) => run.id === runId);
      const requests = pendingMobileRequests(run).filter((request) => request.planId ? request.planId === plan.id
        : request.plan ? request.plan === plan.name : run.plans.length === 1)
        .filter((request) => !review.resolvedRequests.some((resolved) => resolved.requestId === request.requestId));
      if (requests.length && confirm(`请先在学校“我的预约”确认以下请求没有订单，也没有仍在处理的请求：\n${requests.map((request) => `${request.date} ${request.time} ${request.court ?? ''}`).join('\n')}\n确认后可在原预约中重试。是否已确认？`)) {
        requests.forEach((request) => confirmedAbsentIds.add(request.requestId));
      }
    }
    const runs = store.state.runs.map((run) => reviewedMobileRuns([run], plan, review,
      { confirmedAbsentIds: run.id === runId ? confirmedAbsentIds : new Set() })[0]);
    await store.update({ runs });
    toast(pendingMobileRequests(store.state.runs.find((run) => run.id === runId)).length
      ? '结果仍未明确，请在学校“我的预约”查看。' : '预约结果已更新');
  } finally { authBusy = false; refreshingRun = null; render(); }
}
function textStatus(message, failed = false) {
  $('#textStatus').textContent = message; $('#textStatus').className = failed ? 'form-error' : 'field-help';
}
function showText(title, value, fileName = '') {
  $('#textTitle').textContent = title; $('#exportText').value = value;
  $('#copyText').textContent = '复制完整内容'; $('#saveText').hidden = !fileName;
  $('#saveText').dataset.fileName = fileName; $('#saveText').disabled = execution.active || textBusy;
  textStatus(fileName && execution.active ? '本次预约结束后可保存文件。' : ''); $('#textDialog').showModal();
}
function exportAccount(id) { const account = store.state.accounts.find((a) => a.id === id);
  showText('登录 JSON · ' + account.name, JSON.stringify({ format: 'szu-court-session/v1', name: account.name,
    exportedAt: new Date().toISOString(), session: account.session }, null, 2)); }
function openAccount(id) { editable(); editAccount = id ?? null; $('#accountForm').reset(); $('#accountError').textContent = '';
  const account = store.state.accounts.find((a) => a.id === id); $('#accountTitle').textContent = account ? '更新登录' : '导入账号';
  $('#accountName').value = account?.name ?? ''; $('#accountDialog').showModal(); }
function openLogin(id) {
  editable(); loginAccount = id ?? null;
  createAfterLogin = !id && currentTab === 'plans' && !store.state.plans.length;
  const account = store.state.accounts.find((a) => a.id === id);
  $('#loginTitle').textContent = account ? '重新登录 · ' + account.name : '学校账号登录';
  $('#loginName').value = account?.name ?? '';
  $('#loginHint').textContent = account?.userId ? `请登录 ${account.user || account.name} 的学校账号。验证成功才替换登录；取消或登录错账号不会改动原记录。`
    : '将打开学校登录页，获取登录后自动返回。验证通过后保存账号。';
  $('#loginStatus').textContent = ''; $('#loginError').textContent = ''; $('#loginDialog').showModal();
  if (native) $('#openSchoolLogin').click();
}
async function verifyWithSchoolLogin(account) {
  try { return await verifyAccount(store, device, account); }
  catch (error) {
    if (!(error instanceof SessionExpiredError) || !native) throw error;
    accountChecks.set(account.id, { state: 'recovering', message: '登录已失效，正在恢复登录…' }); render();
    toast('场馆登录已失效，正在尝试使用学校登录窗口恢复');
    const captured = await device.login({ fresh: store.state.accounts.length > 1 });
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
  let continueToBooking = false;
  authBusy = true; render(); $('#loginError').textContent = ''; $('#loginStatus').textContent = '请在学校窗口完成登录…';
  $('#loginDialog').querySelectorAll('button, input').forEach((el) => el.disabled = true);
  try {
    const captured = await device.login({ fresh: store.state.accounts.length > 0 });
    $('#loginStatus').textContent = '已获取 Cookie，正在核对学校身份和预约接口…';
    const account = await saveSchoolLogin(store, captured, { accountId, name, transport: nativeTransport(device), confirmIdentity: (identity) => confirm(`识别到 ${identity.name}（学号尾号 ${String(identity.id).slice(-4)}），是否使用此学校账号？`) });
    accountChecks.delete(account.id);
    $('#loginDialog').close(); tab(store.state.plans.length ? 'accounts' : 'plans'); toast('已登录：' + account.user);
    continueToBooking = createAfterLogin;
  } catch (error) {
    $('#loginStatus').textContent = '';
    if (loginCancelled(error)) { createAfterLogin = false; $('#loginDialog').close(); toast('已取消登录'); }
    else throw error;
  }
  finally { authBusy = false; $('#loginDialog').querySelectorAll('button, input').forEach((el) => el.disabled = false); render(); }
  if (continueToBooking) { createAfterLogin = false; openPlan(); }
}, '#loginError');
$('#plans').onchange = (event) => { const id = event.target.dataset.select; if (!id) return; event.target.checked ? selected.add(id) : selected.delete(id); render(); };
$('#plans').onclick = action(async (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  button.closest('.more-actions')?.removeAttribute('open');
  const copy = event.target.closest('[data-copy]'); if (copy) return openPlan(null, repeatPlan(store.state.plans.find((p) => p.id === copy.dataset.copy)));
  const start = event.target.closest('[data-start]'); if (start) return showRunConfirmation([store.state.plans.find((p) => p.id === start.dataset.start)]);
  const results = event.target.closest('[data-results]'); if (results) return showResults(results.dataset.results);
  const login = event.target.closest('[data-login]'); if (login) { tab('accounts'); toast('原账号已删除，请连接账号并在预约中重新选择'); return; }
  const empty = event.target.closest('[data-empty]'); if (empty) { if (empty.dataset.empty === 'new') openPlan(); else { planFilter = 'all'; planQuery = ''; $('#planSearch').value = ''; render(); } return; }
  const edit = event.target.closest('[data-edit]'), del = event.target.closest('[data-delete]');
  if (edit) openPlan(edit.dataset.edit);
  if (del) { editable(); if (!confirm('删除此预约？已保存的执行记录不受影响。')) return;
    const deletingPlan = store.state.plans.find((plan) => plan.id === del.dataset.delete);
    if (store.state.runs.some((run) => pendingMobileRequests(run).some((request) => request.planId === del.dataset.delete
      || request.accountId === deletingPlan.accountId && request.date === deletingPlan.date
        && (!request.project || request.project === deletingPlan.project)))) throw new Error('此账号、日期和项目仍有请求待确认，请先核对后再删除预约');
    await saveChange({ plans: store.state.plans.filter((p) => p.id !== del.dataset.delete) }); selected.delete(del.dataset.delete); render(); }
});
$('#sequence').onclick = (event) => { const b = event.target.closest('[data-move]'); if (!b || b.disabled) return; const i = Number(b.dataset.move), next = i + Number(b.dataset.step); [choices.courts[i], choices.courts[next]] = [choices.courts[next], choices.courts[i]]; renderChoices(); };
function refreshChoices() { catalogError = ''; loadCached(); if (native) void loadSchoolChoices(); }
$('#planProject').onchange = () => { choices.times = []; choices.courts = ['*']; choices.labels = {}; choices.customGoal = choices.preserveGoal = false; $('#sameCourt').checked = $('#planProject').value === 'volleyball'; refreshChoices(); };
$('#planAccount').onchange = refreshChoices;
$('#planDate').onchange = refreshChoices;
$('#bookingGoal').onchange = () => { choices.customGoal = true; choices.preserveGoal = false; renderChoices(); };
async function loadSchoolChoices() {
  if (!ready || authBusy || execution.active || !$('#planDialog').open) return;
  cancelCatalog(); const controller = catalogController = new AbortController();
  const token = ++catalogToken; const account = store.state.accounts.find((a) => a.id === $('#planAccount').value); const project = $('#planProject').value;
  catalogLoading = true; catalogError = ''; $('#loadCatalog').disabled = true; renderChoices();
  try { const catalog = await readCatalog(store, device, account, project, $('#planDate').value, { signal: controller.signal }); if (token === catalogToken) { choices.catalog = catalog; renderChoices(); } }
  catch (error) { if (token === catalogToken) catalogError = error.message; }
  finally { if (catalogController === controller) { catalogController = null; catalogLoading = false; $('#loadCatalog').disabled = false; renderChoices(); } }
}
$('#loadCatalog').onclick = action(loadSchoolChoices, '#planError');
$('#times').onclick = (event) => { const time = event.target.closest('[data-time]')?.dataset.time; if (!time) return;
  if (!choices.customGoal && !choices.times.includes(time) && choices.times.length >= 2) { toast('最多选择两个时段，再次点击可取消已选时段'); return; }
  choices.times = choices.times.includes(time) ? choices.times.filter((t) => t !== time) : [...choices.times, time]; choices.preserveGoal = false; renderChoices(); };
$('#addTime').onclick = action(() => { const time = $('#timeStart').value + '-' + $('#timeEnd').value; splitTimeSlot(time);
  if (!choices.times.includes(time)) choices.times.push(time); choices.preserveGoal = false; renderChoices(); }, '#planError');
$('#courts').onclick = (event) => { const id = event.target.closest('[data-court]')?.dataset.court; if (!id) return;
  choices.courts = choices.courts.includes(id) ? choices.courts.filter((c) => c !== id) : [...choices.courts.filter((c) => c !== '*'), id]; renderChoices(); };
$('#allCourts').onclick = () => { choices.courts = ['*']; renderChoices(); };
$('#planForm').onsubmit = action(async (event) => {
  event.preventDefault(); if (authBusy) return; editable();
  const continueToBooking = !editPlan && shanghaiDate(bookingReleaseAt($('#planDate').value)) <= shanghaiDate();
  const plan = validatePlan({ id: editPlan ?? crypto.randomUUID(), name: $('#planName').value.trim(), accountId: $('#planAccount').value,
    bookingGoal: $('#bookingGoal').value, project: $('#planProject').value, date: $('#planDate').value, times: [...choices.times].sort(), courts: [...choices.courts],
    courtLabels: { ...choices.labels }, includeOtherCourts: $('#includeOtherCourts').checked, preferSameCourt: $('#sameCourt').checked, intervalMs: Number($('#interval').value) * 1000, durationMs: Number($('#duration').value) * 60000 });
  const previousPlan = store.state.plans.find((p) => p.id === plan.id);
  if (previousPlan && previousPlan.date === plan.date && previousPlan.project === plan.project && previousPlan.accountId === plan.accountId) plan.sameCourtAnchor = previousPlan.sameCourtAnchor;
  const plans = previousPlan ? store.state.plans.map((p) => p.id === plan.id ? plan : p) : [...store.state.plans, plan];
  await saveChange({ plans }); $('#planDialog').close(); render();
  if (continueToBooking) showRunConfirmation([plan]); else toast('预约设置已保存，尚未开始预约');
}, '#planError');
$('#sessionFile').onchange = action(async () => { const file = $('#sessionFile').files[0]; if (!file) return;
  if (file.size > 2000000) throw new Error('文件过大'); $('#sessionText').value = await file.text(); }, '#accountError');
$('#accountForm').onsubmit = action(async (event) => {
  event.preventDefault(); editable(); const session = parseSessionText($('#sessionText').value);
  const previous = store.state.accounts.find((a) => a.id === editAccount);
  const account = { ...previous, id: previous?.id ?? crypto.randomUUID(), name: $('#accountName').value.trim() || session.user || '学校账号', session, verifiedAt: null };
  authBusy = true; render();
  try {
    if (previous?.userId) { const { api, client } = createConnection(store, device, account);
      try { const identity = await api.getIdentity();
        if (identity.id !== previous.userId) throw new Error('这不是原来的学校账号，请新增用户后导入');
      } finally { await client.flush(); }
    }
    await store.update({ accounts: previous ? store.state.accounts.map((a) => a.id === account.id ? account : a) : [...store.state.accounts, account] });
    accountChecks.delete(account.id);
    $('#accountDialog').close(); if (!store.state.plans.length) tab('plans'); toast('登录已保存，执行前会核对身份');
  } finally { authBusy = false; render(); }
}, '#accountError');
$('#accounts').onclick = action(async (event) => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  button.closest('.more-actions')?.removeAttribute('open');
  if (button.dataset.export) return exportAccount(button.dataset.export);
  editable();
  if (button.dataset.relogin) return openLogin(button.dataset.relogin);
  if (button.dataset.update) return openAccount(button.dataset.update);
  if (button.dataset.verify) {
    const id = button.dataset.verify;
    authBusy = true; accountChecks.set(id, { state: 'checking', message: '正在检查登录…' }); render();
    try {
      const identity = await verifyWithSchoolLogin(store.state.accounts.find((a) => a.id === id));
      accountChecks.set(id, { state: 'success', message: '刚刚检查，登录正常' }); toast('登录正常：' + identity.name);
    } catch (error) {
      accountChecks.set(id, { state: loginCancelled(error) ? 'cancelled' : 'error', message: error.message });
      if (loginCancelled(error)) toast('已取消登录'); else throw error;
    }
    finally { authBusy = false; render(); } }
  if (button.dataset.remove) { const id = button.dataset.remove;
    if (store.state.plans.some((p) => p.accountId === id)) throw new Error('请先删除或修改使用此账号的预约');
    if (store.state.runs.some((run) => pendingMobileRequests(run).some((request) => request.accountId === id))) throw new Error('此账号仍有请求待确认，请先核对后再删除账号');
    if (!confirm('删除此账号及其登录？学校预约不会取消。')) return;
    await saveChange({ accounts: store.state.accounts.filter((a) => a.id !== id) }); }
});
async function exportText(saveFile) {
  if (textBusy) return;
  if (saveFile && execution.active) { textStatus('请等本次预约结束后再保存文件。', true); return; }
  textBusy = true; $('#copyText').disabled = $('#saveText').disabled = true;
  textStatus(saveFile ? '请选择保存位置…' : '正在复制…');
  try {
    const text = $('#exportText').value;
    if (saveFile) {
      const result = await device.saveText({ text, fileName: $('#saveText').dataset.fileName });
      textStatus(result?.cancelled ? '已取消保存，内容仍保留。' : '文件已保存，包含完整诊断日志。');
    } else {
      await device.copy({ text }); $('#copyText').textContent = '已复制';
      textStatus(`复制成功，共 ${text.length} 个字符。`);
    }
  } catch (error) { textStatus((saveFile ? '保存失败：' : '复制失败：') + error.message, true); }
  finally { textBusy = false; $('#copyText').disabled = false; $('#saveText').disabled = execution.active; }
}
$('#copyText').onclick = () => exportText(false);
$('#saveText').onclick = () => exportText(true);
function showRunConfirmation(plans) {
  editable(); if (!plans.length) throw new Error('请先选择预约');
  plans.forEach(validatePlan); $('#confirmError').textContent = '';
  $('#confirmPlans').textContent = plans.map((p) => `${PROJECTS.find((project) => project.id === p.project)?.label} · ${friendlyDate(p.date)}\n${p.times.join('、')}\n${p.courts.includes('*') ? '不限场地' : courtDescription(p)}${store.state.accounts.length > 1 ? '\n账号：' + accountName(p.accountId) : ''}`).join('\n\n');
  if (plans.some((p) => shanghaiDate(bookingReleaseAt(p.date)) > shanghaiDate())) throw new Error('请在放号当天登录并启动；预约已保存，无需提前守候');
  const waiting = plans.filter((p) => bookingReleaseAt(p.date) > Date.now());
  $('#confirmTiming').textContent = waiting.length === plans.length ? '确认后等待今天 12:30 放号，再自动尝试预约。' : waiting.length ? '已开放的现在预约，其余等待今天 12:30。' : '确认后立即尝试预约。';
  confirmSelection = plans.map((p) => p.id);
  $('#confirmDialog').showModal();
}
$('#begin').onclick = action(() => showRunConfirmation(store.state.plans.filter((p) => selected.has(p.id))));
$('#batchSelect').onclick = () => { batchMode = true; $('#planTools').open = false; render(); };
$('#endBatch').onclick = () => { batchMode = false; selected.clear(); render(); };
$('#confirmStart').onclick = action(async () => {
  editable();
  if (!native) throw new Error('网页预览不能执行，请安装 APK');
  const plans = store.state.plans.filter((p) => confirmSelection.includes(p.id)); const mode = 'auto';
  const confirmedAt = Date.now();
  cancelCatalog();
  archivedRuns = []; archiveCursor = ''; archiveHasMore = true;
  $('#toast').classList.remove('show');
  const work = execution.start(plans, mode, { confirmedAt });
  if (!execution.active) { await work; return; }
  selected.clear(); batchMode = false;
  $('#confirmDialog').close(); tab('results'); render();
  try { await work; } catch (error) { toast('执行未正常保存：' + error.message); }
  finally { render(); }
}, '#confirmError');
$('#stop').onclick = () => execution.stop();
$('#runs').onclick = action(async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.disabled) return;
  if (button.dataset.runRefresh) {
    const run = historyRuns().find((record) => record.id === button.dataset.runRefresh);
    const plan = run.plans.find((record) => record.id === button.dataset.refreshPlan);
    return refreshRunResults(run.id, structuredClone(plan));
  }
  if (button.dataset.runAbsent) {
    const run = store.state.runs.find((record) => record.id === button.dataset.runAbsent);
    const plan = run.plans.find((record) => record.id === button.dataset.absentPlan);
    return refreshRunResults(run.id, structuredClone(plan), { confirmAbsent: true });
  }
    if (button.dataset.runExport) { const run = historyRuns().find((r) => r.id === button.dataset.runExport); showText('诊断记录 JSON', JSON.stringify(exportDiagnostics(run), null, 2), `court-diagnostics-${run.id}.json`); }
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
  if (ex.primary === 'results') { showResults(plan.id); return; }
  if (ex.phase === 'login') { tab('accounts'); return; }
  if (ex.phase === 'expired') { openPlan(null, repeatPlan(plan)); return; }
  if (ex.phase === 'future') { openPlan(plan.id); return; }
  showRunConfirmation([store.state.plans.find((p) => p.id === plan.id)]);
}
$('#planSearch').oninput = () => { planQuery = $('#planSearch').value; render(); };
document.querySelectorAll('[data-filter]').forEach((button) => button.onclick = () => { planFilter = button.dataset.filter; render(); });
async function init() {
  await store.load(); ready = true;
  $('#runtime').textContent = '预览'; $('#runtime').hidden = native;
  await device.addListener('foreground', ({ active }) => { foreground = active; if (!active) execution.stop('background'); });
  tab(currentTab); render(); setInterval(() => { if (!execution.active) render(); else renderProgress(); }, 1000);
}
init().catch((error) => { $('#fatal').hidden = false; $('#fatal').textContent = error.message;
  document.querySelectorAll('button').forEach((button) => button.disabled = true); });
