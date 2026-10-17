// Presentation only: school responses and execution validation remain authoritative.
export const ACTIVE_STATES = ['scheduled', 'queued', 'preparing', 'checking', 'waiting', 'booking', 'stopping'];
const dayMs = 86400000;
export const todayInShanghai = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
export const releaseTime = (date) => Date.parse(`${shiftDate(date, -1)}T12:30:00+08:00`);

// While the worker is alive, a prepared intent has not been dispatched yet.
// After interruption, older workers may have sent it before persisting sentAt.
export function pendingExecutionRequests(run) {
  const entries = Object.entries(run?.pendingRequests ?? {});
  if (!entries.length && run?.inFlight) entries.push([run.inFlight.requestId ?? 'legacy', run.inFlight]);
  return entries.filter(([id, request]) => request && !request.reviewedAt
    && !run?.reviewedRequests?.[id] && !((ACTIVE_STATES.includes(run?.status)
      || (run?.dispatchJournalVersion === 1 && run?.dispatchJournalChecked === true)) && request.preparedAt && !request.sentAt))
    .map(([id, request]) => ({ ...request, requestId: request.requestId ?? id }));
}

export function friendlyDate(date, now = Date.now()) {
  const today = todayInShanghai(now);
  const distance = Math.round((Date.parse(date) - Date.parse(today)) / dayMs);
  const prefix = ({ '-1': '昨天', 0: '今天', 1: '明天', 2: '后天' })[distance];
  const week = new Date(`${date}T12:00:00+08:00`).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' });
  return `${prefix ? prefix + ' · ' : ''}${date.slice(5).replace('-', '月')}日 ${week}`;
}

export function planExperience(plan, { now = Date.now(), account, run } = {}) {
  const releaseAt = releaseTime(plan.date);
  const pending = pendingExecutionRequests(run).length > 0;
  const expired = plan.date < todayInShanghai(now) || (plan.times?.length > 0 && plan.times.every((time) =>
    Date.parse(`${plan.date}T${time.split('-')[0]}:00+08:00`) <= now));
  const active = ACTIVE_STATES.includes(run?.status);
  const reviewed = run?.reviewedOutcome === 'success';
  const failed = !reviewed && run?.mode !== 'check' && (['error', 'partial', 'interrupted', 'no_result', 'missed', 'corrupt', 'limited'].includes(run?.status)
    || (run?.status === 'stopped' && run?.successes?.length > 0));
  const needsReview = failed && (run?.successes?.length > 0 || ['partial', 'corrupt', 'limited'].includes(run?.status));
  const completed = (run?.status === 'success' || reviewed) && run?.mode !== 'check';
  let phase, hint, action;
  if (active) { phase = 'active'; hint = run.status === 'waiting' ? '正在倒计时，保持设备在线'
    : run.activity === 'cooldown' ? `学校限制请求，等待重试${run.retryAt > now ? `（约 ${Math.ceil((run.retryAt - now) / 1000)} 秒）` : ''}`
      : run.activityMessage || '执行正在进行，可查看进度或停止'; action = '查看进度'; }
  else if (pending) { phase = 'attention'; hint = '有结果待确认，先核对学校订单'; action = '核对与重试'; }
  else if (expired) { phase = 'expired'; hint = '候选时段已开始，可复用到新日期'; action = '再约一次'; }
  else if (completed) { phase = 'done'; hint = '预约已完成，请到学校核对 / 付款'; action = '查看结果'; }
  else if (!account || account.exists === false) { phase = 'login'; hint = '预约账号不可用，请先登录或更换账号'; action = '更新登录'; }
  else if (releaseAt > now && todayInShanghai(releaseAt) > todayInShanghai(now)) {
    phase = 'future'; hint = `${friendlyDate(todayInShanghai(releaseAt), now)} 12:30 放号`; action = '放号当天可启动';
  } else {
    phase = needsReview ? 'attention' : 'ready';
    hint = needsReview ? '查询学校订单，排除已约时段后生成剩余预约' : failed ? '上次未约到，可重新尝试；开始前会自动核对学校订单' : releaseAt > now ? '今天 12:30 放号' : '已放号';
    action = needsReview ? '核对与重试' : releaseAt > now ? '开始倒计时' : '立即尝试';
  }
  return { phase, hint, action, releaseAt, expired, active, pending,
    canStart: !active && !pending && !expired && !completed && Boolean(account && account.exists !== false)
      && todayInShanghai(releaseAt) <= todayInShanghai(now) };
}

export function visiblePlans(items, { filter = 'recent', query = '', accountId = '' } = {}) {
  const term = query.trim().toLocaleLowerCase();
  const ranks = { active: 0, attention: 1, login: 2, ready: 3, future: 4, done: 5, expired: 6 };
  return items.filter(({ plan, experience }) => {
    if (accountId && (plan.accountId ?? 'default') !== accountId) return false;
    if (term && ![plan.name, plan.projectLabel, plan.date, ...(plan.times ?? []), ...Object.values(plan.courtLabels ?? {})].join(' ').toLocaleLowerCase().includes(term)) return false;
    if (filter === 'recent') return experience.phase !== 'expired';
    if (filter === 'active') return experience.active;
    if (filter === 'attention') return experience.phase === 'attention' || experience.phase === 'login';
    return true;
  }).sort((a, b) => ranks[a.experience.phase] - ranks[b.experience.phase] || a.plan.date.localeCompare(b.plan.date));
}

export function repeatPlan(plan, now = Date.now()) {
  const copy = structuredClone(plan);
  for (const key of ['id', 'revision', 'sameCourtAnchor', 'startAt', 'createdAt', 'updatedAt']) delete copy[key];
  const tomorrow = shiftDate(todayInShanghai(now), 1);
  copy.date = plan.date >= tomorrow && plan.date <= shiftDate(tomorrow, 6) ? plan.date : tomorrow;
  copy.name = plan.projectLabel && bookingTitle(plan, plan.projectLabel) === plan.projectLabel ? '' : plan.name ?? '';
  return copy;
}

export function selectionSummary(times, courts, goal = 'two') {
  const goals = { one: '任选一段', consecutive: '连续两段', two: '任意两段' };
  const distinctEnough = new Set(times).size >= 2;
  const nonoverlappingPair = times.some((a) => times.some((b) => a !== b
    && (a.split('-')[1] <= b.split('-')[0] || b.split('-')[1] <= a.split('-')[0])));
  const goalValid = goal === 'two' ? distinctEnough && nonoverlappingPair
    : goal !== 'consecutive' || times.some((a) => times.some((b) => a !== b && (a.split('-')[1] === b.split('-')[0] || b.split('-')[1] === a.split('-')[0])));
  return { valid: times.length > 0 && courts.length > 0 && goalValid,
    text: !times.length ? '尚未选择时段' : !courts.length ? `已选 ${times.length} 个候选时段 · 尚未选择场地`
      : !goalValid ? goal === 'two' ? !distinctEnough ? '任意两段需要至少选择两个候选时段' : '任意两段需要至少一组互不重叠的候选时段' : '连续两段需要选择首尾相接的时段'
        : `${goals[goal]} · ${times.length} 个候选时段 · ${courts.includes('*') ? '全部场地' : courts.length + ' 个优先场地'}` };
}

// Ordinary bookings use the selected slots directly; choosing a single slot
// should never require changing an unrelated goal control.
export function selectedBookingGoal(times) {
  return new Set(times).size <= 1 ? 'one' : 'two';
}

export function bookingTitle(plan, projectLabel) {
  const name = plan.name?.trim();
  return !name || name === `${projectLabel}预约` || name === `${plan.date} ${projectLabel} ${plan.times?.[0]}` ? projectLabel : name;
}

// A changed mobile plan must never display a previous revision as its current result.
export function matchingMobileRun(plan, runs) {
  const value = (p, key) => p[key] ?? (key === 'bookingGoal' ? new Set(p.times).size === 1 ? 'one' : 'two'
    : ({ preferSameCourt: false, includeOtherCourts: false })[key]);
  const same = (old) => ['date', 'accountId', 'project', 'bookingGoal', 'preferSameCourt', 'includeOtherCourts', 'intervalMs', 'durationMs', 'sameCourtAnchor']
    .every((key) => JSON.stringify(value(old, key)) === JSON.stringify(value(plan, key)))
    && JSON.stringify(old.times) === JSON.stringify(plan.times) && JSON.stringify(old.courts) === JSON.stringify(plan.courts);
  const run = [...runs].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .find((r) => r.plans?.some((p) => p.id === plan.id && same(p)));
  if (!run) return null;
  const item = run.items?.find((i) => i.id === plan.id);
  const requests = Object.values(run.pendingRequests ?? {});
  if (!requests.length && run.inFlight) requests.push(run.inFlight);
  const pendingRequests = requests.filter((request) => request.planId === plan.id
    || (!request.planId && request.plan === plan.name));
  return { ...run, status: item?.status ?? run.status, reviewedOutcome: item?.reviewedOutcome,
    activity: item?.activity, activityMessage: item?.activityMessage, retryAt: item?.retryAt,
    pendingRequests: Object.fromEntries(pendingRequests.map((request, i) => [request.requestId ?? String(i), request])),
    inFlight: pendingRequests[0] ?? null,
    successes: (run.successes ?? []).filter((s) => s.planId === plan.id || (!s.planId && s.plan === plan.name)) };
}

// Native details menus retain keyboard access; keep them inside the viewport.
export function installMenus(doc = document) {
  const menus = () => [...doc.querySelectorAll('.more-actions[open]')];
  doc.addEventListener('pointerdown', (event) => {
    for (const menu of menus()) if (!menu.contains(event.target)) menu.open = false;
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menus().length) return;
    event.preventDefault();
    for (const menu of menus()) { menu.open = false; menu.querySelector('summary').focus(); }
  });
  doc.addEventListener('toggle', (event) => {
    const menu = event.target;
    if (!menu.matches?.('.more-actions') || !menu.open) return;
    for (const other of menus()) if (other !== menu) other.open = false;
    menu.classList.remove('opens-up', 'align-start', 'align-end');
    const panel = menu.querySelector('div');
    const rect = panel.getBoundingClientRect();
    if (rect.bottom > doc.defaultView.innerHeight - 12) menu.classList.add('opens-up');
    if (rect.left < 12) menu.classList.add('align-start');
    if (rect.right > doc.defaultView.innerWidth - 12) menu.classList.add('align-end');
  }, true);
}
