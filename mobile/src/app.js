import { device, native, nativeTransport } from './device.js';
import { saveSchoolLogin } from './login.js';
import { MobileStore } from './store.js';
import { ForegroundExecution, validatePlan } from './execution.js';
import { createConnection, verifyAccount, readCatalog } from './school.js';
import { PROJECTS } from '../../shared/projects.js';
import { parseSessionText } from '../../shared/session-format.js';
import { shanghaiDate, addDays, splitTimeSlot } from '../../shared/utils.js';
import { bookingReleaseAt } from '../../shared/runner.js';
import { SessionExpiredError } from '../../shared/errors.js';

const $ = (s) => document.querySelector(s);
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const format = (epoch) => new Date(epoch).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const labels = { preparing: '准备中', waiting: '等待放号', booking: '抢场中', stopping: '正在停止', stopped: '已停止',
  interrupted: '已中断', success: '已完成', partial: '部分成功', error: '执行失败', missed: '已错过' };
const store = new MobileStore(device);
const selected = new Set();
let ready = false, foreground = !document.hidden, editPlan = null, editAccount = null, catalogToken = 0, currentTab = 'plans';
let choices = { times: [], courts: [], labels: {}, catalog: null };
let loginAccount = null, authBusy = false;
const execution = new ForegroundExecution({ store, device, createApi: (account, token) => createConnection(store, device, account, token),
  changed: () => render(), isForeground: () => foreground && !document.hidden });
const accountName = (id) => store.state.accounts.find((a) => a.id === id)?.name ?? '账号已删除';
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4500); }
function editable() { if (!ready) throw new Error('数据尚未加载'); if (execution.active) throw new Error('请先停止当前执行，再修改方案或账号'); if (authBusy) throw new Error('登录或验证尚未结束，请稍候'); }
function action(fn, errorTarget) { return async (event) => {
  try { await fn(event); } catch (error) { if (errorTarget) $(errorTarget).textContent = error.message; else toast(error.message); }
}; }
function tab(name) {
  currentTab = name;
  for (const key of ['plans', 'results', 'accounts']) $('#' + key + 'Page').hidden = key !== name;
  document.querySelectorAll('[data-tab]').forEach((el) => el.setAttribute('aria-current', el.dataset.tab === name ? 'page' : 'false'));
}
function courtDescription(plan) { return plan.courts.includes('*') ? '按学校顺序尝试全部场地'
  : plan.courts.map((id, i) => `${i + 1}. ${plan.courtLabels?.[id] ?? id}`).join(' → ')
    + (plan.includeOtherCourts ? ' → 其余场地（学校顺序）' : '（仅尝试已选场地）'); }
function render() {
  if (!ready) return;
  $('#newPlan').disabled = $('#newAccount').disabled = $('#schoolLogin').disabled = execution.active || authBusy;
  $('#begin').disabled = execution.active || authBusy || selected.size === 0;
  $('#stop').hidden = !execution.active;
  $('#selectedCount').textContent = execution.active ? '当前有执行正在进行' : `已选 ${selected.size} 个方案`;
  // Keep user focus/scroll stable while logs stream in.
  const signature = JSON.stringify([store.state.plans, store.state.accounts.map((a) => [a.id, a.name, a.user, a.verifiedAt]), [...selected], execution.active]);
  if (render.signature !== signature) {
    render.signature = signature;
    $('#plans').innerHTML = store.state.plans.length ? store.state.plans.map((p) => `<article class="task-card" data-plan="${p.id}">
      <div class="task-head"><label class="plan-select"><input type="checkbox" data-select="${p.id}" ${selected.has(p.id) ? 'checked' : ''} ${execution.active ? 'disabled' : ''}><div><h3>${escape(p.name)}</h3><p class="task-date">${escape(p.date)} · ${escape(accountName(p.accountId))}</p></div></label><span class="project-tag">${escape(PROJECTS.find((s) => s.id === p.project)?.label)}</span></div>
      <div class="task-content"><div class="chips">${p.times.map((t) => `<span class="chip">${escape(t)}</span>`).join('')}</div><p class="court-description">${escape(courtDescription(p))}</p><p class="same-court">${p.preferSameCourt ? '✓ 优先同一场地' : '各时段按原顺序尝试'}</p></div>
      <p class="plan-timing">放号：${format(bookingReleaseAt(p.date))}（北京时间）<br>每 ${p.intervalMs / 1000} 秒重试 · 最长 ${p.durationMs / 60000} 分钟</p>
      <div class="task-actions"><button class="text-button" data-edit="${p.id}" ${execution.active ? 'disabled' : ''}>编辑</button><button class="text-button danger-text" data-delete="${p.id}" ${execution.active ? 'disabled' : ''}>删除</button></div></article>`).join('') : '<div class="empty">先登录或导入账号，再新建预约方案。<br>方案可以保存，但不会在后台自行启动。</div>';
    $('#accounts').innerHTML = store.state.accounts.length ? store.state.accounts.map((a) => `<article class="task-card"><h3>${escape(a.name)}</h3><p class="task-date">${a.verifiedAt ? '上次验证：' + escape(a.user) + ' · ' + escape(format(a.verifiedAt)) + '（启动时重新验证）' : '登录已保存，尚未验证'}</p><div class="task-actions">
      <button class="secondary" data-relogin="${a.id}" ${execution.active ? 'disabled' : ''}>重新登录</button><button class="text-button" data-verify="${a.id}" ${execution.active ? 'disabled' : ''}>验证</button><button class="text-button" data-export="${a.id}">查看 / 复制 JSON</button><button class="text-button" data-update="${a.id}" ${execution.active ? 'disabled' : ''}>导入更新</button><button class="text-button danger-text" data-remove="${a.id}" ${execution.active ? 'disabled' : ''}>删除</button></div></article>`).join('') : '<div class="empty">点击“学校登录”，直接在手机上连接账号。<br>也可导入 JSON，多位用户独立保存。</div>';
  }
  renderProgress();
  const runSignature = JSON.stringify(store.state.runs);
  if (render.runSignature !== runSignature) {
    render.runSignature = runSignature;
    const expanded = new Set([...document.querySelectorAll('[data-log][open]')].map((el) => el.dataset.log));
    $('#runs').innerHTML = store.state.runs.length ? store.state.runs.map((run) => `<article class="task-card">
      <div class="task-head"><h3>${escape(run.plans.map((p) => p.name).join('、'))}</h3><span class="badge ${escape(run.status)}">${labels[run.status] ?? run.status}</span></div>
      <p class="run-meta">${format(run.startedAt)} · ${run.mode === 'now' ? '立即尝试' : '等待 12:30 放号'}</p>
      ${run.error ? `<p class="task-error">${escape(run.error)}</p>` : ''}
      ${run.inFlight ? `<p class="task-error">${run.finishedAt ? '待核对' : '请求已发出'}：${escape(run.inFlight.plan)} ${escape(run.inFlight.time)} ${escape(run.inFlight.court)}</p>` : ''}
      ${run.successes.map((s) => `<p class="run-result">✓ ${escape(accountName(s.accountId))} · ${escape(s.date)}<br>${escape(s.time)} · ${escape(s.court)}${s.orderId ? '<br>订单：' + escape(s.orderId) : ''}</p>`).join('') || '<p class="run-meta">尚无成功记录</p>'}
      ${run.items.map((i) => `<p class="run-meta">${escape(i.name)}：${i.limited ? '已达当日两时段上限' : labels[i.status] ?? i.status}${i.error ? ' · ' + escape(i.error) : ''}</p>`).join('')}
      <details data-log="${run.id}" ${expanded.has(run.id) ? 'open' : ''}><summary>详细日志（${run.logs.length} 条）</summary><div class="run-logs">${run.logs.map((l) => escape(`${format(l.time)} ${l.level} ${l.message}${l.details ? ' ' + JSON.stringify(l.details) : ''}`)).join('\n')}</div></details>
      <div class="task-actions"><button class="text-button" data-run-export="${run.id}">导出记录</button>${run.finishedAt ? `<button class="text-button danger-text" data-run-delete="${run.id}">删除记录</button>` : ''}</div></article>`).join('') : '<div class="empty">还没有执行记录。<br>预约成功后请到学校系统付款。</div>';
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
  catalogToken++;
  choices.catalog = store.state.catalogs[$('#planAccount').value + ':' + $('#planProject').value] ?? null;
  renderChoices();
}
function renderChoices() {
  const catalog = choices.catalog;
  $('#catalogNote').textContent = catalog ? `目录参考 ${catalog.date}，不代表目标日期可订。可点击重新读取。` : '请先读取学校目录；也可选择按学校顺序全部尝试。';
  const times = [...new Set([...(catalog?.times ?? []), ...choices.times])].sort();
  $('#times').innerHTML = times.map((time) => `<button type="button" class="time-option ${choices.times.includes(time) ? 'selected' : ''}" data-time="${escape(time)}">${escape(time)}</button>`).join('');
  const courts = [...(catalog?.courts ?? [])];
  for (const id of choices.courts.filter((c) => c !== '*')) if (!courts.some((c) => c.id === id)) courts.push({ id, name: choices.labels[id] ?? '已保存场地' });
  $('#courts').innerHTML = courts.map((court) => { const n = choices.courts.indexOf(court.id); choices.labels[court.id] = court.name;
    return `<button type="button" class="court-card ${n >= 0 ? 'selected' : ''}" data-court="${escape(court.id)}"><span class="court-order">${n >= 0 ? n + 1 : '+'}</span><span class="court-name">${escape(court.name)}</span></button>`; }).join('');
  $('#sequence').textContent = choices.courts.includes('*') ? '按学校顺序尝试全部场地' : choices.courts.map((id, i) => `${i + 1}. ${choices.labels[id] ?? id}`).join(' → ');
}
function openPlan(id) {
  editable();
  if (!store.state.accounts.length) { tab('accounts'); toast('请先登录或导入一个账号'); return; }
  const plan = store.state.plans.find((p) => p.id === id); editPlan = plan?.id ?? null;
  $('#planForm').reset(); $('#planError').textContent = ''; $('#planTitle').textContent = plan ? '编辑方案' : '新建方案';
  $('#planName').value = plan?.name ?? '';
  $('#planAccount').innerHTML = store.state.accounts.map((a) => `<option value="${a.id}">${escape(a.name)}</option>`).join('');
  $('#planAccount').value = plan?.accountId ?? store.state.accounts[0].id;
  $('#planProject').innerHTML = PROJECTS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  $('#planProject').value = plan?.project ?? 'badminton';
  const dates = Array.from({ length: 8 }, (_, i) => addDays(shanghaiDate(), i));
  $('#planDate').innerHTML = dates.map((d) => `<option value="${d}">${d}</option>`).join('');
  $('#planDate').value = dates.includes(plan?.date) ? plan.date : dates[1];
  $('#sameCourt').checked = plan?.preferSameCourt ?? false;
  $('#includeOtherCourts').checked = plan?.includeOtherCourts ?? false;
  $('#interval').value = (plan?.intervalMs ?? 100) / 1000; $('#duration').value = (plan?.durationMs ?? 120000) / 60000;
  choices = { times: [...(plan?.times ?? [])], courts: [...(plan?.courts ?? [])], labels: { ...plan?.courtLabels }, catalog: null };
  loadCached(); $('#planDialog').showModal();
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
    : '将打开学校登录页并尝试沿用本 App 登录窗口已有的学校会话；如需换号，请在学校窗口点击“换号 / 重试”。进入场馆页面后自动获取 Cookie 并验证。';
  $('#loginStatus').textContent = ''; $('#loginError').textContent = ''; $('#loginDialog').showModal();
}
async function verifyWithSchoolLogin(account) {
  try { return await verifyAccount(store, device, account); }
  catch (error) {
    if (!(error instanceof SessionExpiredError) || !native) throw error;
    toast('场馆登录已失效，正在尝试使用学校登录窗口恢复');
    const captured = await device.login();
    const updated = await saveSchoolLogin(store, captured, { accountId: account.id,
      name: account.name, transport: nativeTransport(device) });
    return { id: updated.userId, name: updated.user };
  }
}

document.querySelectorAll('[data-tab]').forEach((el) => el.onclick = () => tab(el.dataset.tab));
document.querySelectorAll('[data-close]').forEach((el) => el.onclick = () => { $('#' + el.dataset.close + 'Dialog').close(); if (el.dataset.close === 'plan') catalogToken++; });
$('#planDialog').addEventListener('close', () => catalogToken++);
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
    const account = await saveSchoolLogin(store, captured, { accountId, name, transport: nativeTransport(device) });
    $('#loginDialog').close(); tab('accounts'); toast('已连接：' + account.user);
  } catch (error) { $('#loginStatus').textContent = ''; throw error; }
  finally { authBusy = false; $('#loginDialog').querySelectorAll('button, input').forEach((el) => el.disabled = false); render(); }
}, '#loginError');
$('#plans').onchange = (event) => { const id = event.target.dataset.select; if (!id) return; event.target.checked ? selected.add(id) : selected.delete(id); render(); };
$('#plans').onclick = action(async (event) => {
  const edit = event.target.closest('[data-edit]'), del = event.target.closest('[data-delete]');
  if (edit) openPlan(edit.dataset.edit);
  if (del) { editable(); if (!confirm('删除此方案？已保存的执行记录不受影响。')) return;
    store.state.plans = store.state.plans.filter((p) => p.id !== del.dataset.delete); selected.delete(del.dataset.delete); await store.save(); render(); }
});
$('#planProject').onchange = () => { choices.times = []; choices.courts = []; choices.labels = {}; $('#sameCourt').checked = $('#planProject').value === 'volleyball'; loadCached(); };
$('#planAccount').onchange = () => loadCached();
$('#loadCatalog').onclick = action(async () => {
  const token = ++catalogToken; const account = store.state.accounts.find((a) => a.id === $('#planAccount').value); const project = $('#planProject').value;
  $('#loadCatalog').disabled = true; $('#planError').textContent = '';
  try { const catalog = await readCatalog(store, device, account, project); if (token === catalogToken) { choices.catalog = catalog; renderChoices(); } }
  catch (error) { if (token === catalogToken) throw error; }
  finally { $('#loadCatalog').disabled = false; }
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
    project: $('#planProject').value, date: $('#planDate').value, times: [...choices.times].sort(), courts: [...choices.courts],
    courtLabels: { ...choices.labels }, includeOtherCourts: $('#includeOtherCourts').checked, preferSameCourt: $('#sameCourt').checked, intervalMs: Number($('#interval').value) * 1000, durationMs: Number($('#duration').value) * 60000 });
  const index = store.state.plans.findIndex((p) => p.id === plan.id);
  if (index < 0) store.state.plans.push(plan); else store.state.plans[index] = plan;
  await store.save(); selected.add(plan.id); $('#planDialog').close(); render(); toast('方案已保存，尚未执行');
}, '#planError');
$('#sessionFile').onchange = action(async () => { const file = $('#sessionFile').files[0]; if (!file) return;
  if (file.size > 2000000) throw new Error('文件过大'); $('#sessionText').value = await file.text(); }, '#accountError');
$('#accountForm').onsubmit = action(async (event) => {
  event.preventDefault(); editable(); const session = parseSessionText($('#sessionText').value);
  const previous = store.state.accounts.find((a) => a.id === editAccount);
  const account = { ...previous, id: previous?.id ?? crypto.randomUUID(), name: $('#accountName').value.trim(), session, verifiedAt: null };
  if (!account.name) throw new Error('请填写账号备注');
  if (previous?.userId) { const { api } = createConnection(store, device, account); const identity = await api.getIdentity();
    if (identity.id !== previous.userId) throw new Error('这不是原来的学校账号，请新增用户后导入'); }
  if (previous) store.state.accounts[store.state.accounts.indexOf(previous)] = account; else store.state.accounts.push(account);
  await store.save(); $('#accountDialog').close(); render(); toast('登录已保存，执行前会核对身份');
}, '#accountError');
$('#accounts').onclick = action(async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.export) return exportAccount(button.dataset.export);
  editable();
  if (button.dataset.relogin) return openLogin(button.dataset.relogin);
  if (button.dataset.update) return openAccount(button.dataset.update);
  if (button.dataset.verify) { button.disabled = true;
    try { const identity = await verifyWithSchoolLogin(store.state.accounts.find((a) => a.id === button.dataset.verify)); toast('验证成功：' + identity.name); render(); }
    finally { button.disabled = false; } }
  if (button.dataset.remove) { const id = button.dataset.remove;
    if (store.state.plans.some((p) => p.accountId === id)) throw new Error('请先删除或修改使用此账号的方案');
    if (!confirm('删除此账号及其登录？学校预约不会取消。')) return;
    store.state.accounts = store.state.accounts.filter((a) => a.id !== id); await store.save(); render(); }
});
$('#copyText').onclick = action(async () => { await device.copy({ text: $('#exportText').value }); toast('完整内容已复制'); });
$('#begin').onclick = action(() => {
  editable(); const plans = store.state.plans.filter((p) => selected.has(p.id)); if (!plans.length) throw new Error('请先选择方案');
  plans.forEach(validatePlan); $('#confirmError').textContent = '';
  const prior = store.state.runs.filter((r) => r.finishedAt && plans.some((p) =>
    (r.inFlight?.accountId === p.accountId && r.inFlight?.date === p.date)
    || r.successes.some((s) => s.accountId === p.accountId && s.date === p.date && p.times.includes(s.time))));
  if (prior.length && !confirm('所选账号和日期已有成功或结果待确认的记录。请先到学校“我的预约”核对，并移除已约时段，避免重复提交。确认仍要继续？')) return;
  $('#confirmPlans').textContent = plans.map((p) => `${p.name} · ${accountName(p.accountId)}\n使用场地：${p.date} ${p.times.join('、')}\n放号：${format(bookingReleaseAt(p.date))}（北京时间）`).join('\n\n');
  const released = plans.some((p) => bookingReleaseAt(p.date) <= Date.now());
  if (plans.some((p) => shanghaiDate(bookingReleaseAt(p.date)) > shanghaiDate())) throw new Error('请在放号当天登录并启动；方案已保存，无需提前守候');
  document.querySelector('input[name=mode][value=release]').disabled = released;
  document.querySelector(`input[name=mode][value=${released ? 'now' : 'release'}]`).checked = true;
  $('#confirmDialog').showModal();
});
$('#confirmStart').onclick = action(async () => {
  editable();
  if (!native) throw new Error('网页预览不能执行，请安装 APK');
  const plans = store.state.plans.filter((p) => selected.has(p.id)); const mode = document.querySelector('input[name=mode]:checked').value;
  authBusy = true; $('#confirmDialog').querySelectorAll('button').forEach((button) => button.disabled = true); render();
  $('#toast').classList.remove('show');
  try {
    for (const id of new Set(plans.map((plan) => plan.accountId))) {
      const account = store.state.accounts.find((item) => item.id === id);
      if (!account) throw new Error('方案账号已不存在');
      await verifyWithSchoolLogin(account);
    }
    authBusy = false;
    const work = execution.start(plans, mode); $('#confirmDialog').close(); tab('results');
    try { await work; } catch (error) { toast('执行未正常保存：' + error.message); }
  } finally { authBusy = false; $('#confirmDialog').querySelectorAll('button').forEach((button) => button.disabled = false); render(); }
}, '#confirmError');
$('#stop').onclick = () => execution.stop();
$('#runs').onclick = action(async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.runExport) { const run = store.state.runs.find((r) => r.id === button.dataset.runExport); showText('执行记录 JSON', JSON.stringify(run, null, 2)); }
  if (button.dataset.runDelete) { editable(); if (!confirm('删除这次本地记录？学校预约不会取消。')) return;
    store.state.runs = store.state.runs.filter((r) => r.id !== button.dataset.runDelete); await store.save(); render(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) execution.stop('background'); });
window.addEventListener('pagehide', () => execution.stop('background'));
async function init() {
  await store.load(); ready = true;
  $('#runtime').textContent = native ? '仅前台执行' : '网页预览';
  await device.addListener('foreground', ({ active }) => { foreground = active; if (!active) execution.stop('background'); });
  tab(currentTab); render(); setInterval(renderProgress, 1000);
}
init().catch((error) => { $('#fatal').hidden = false; $('#fatal').textContent = error.message;
  document.querySelectorAll('button').forEach((button) => button.disabled = true); });
