import { readCourtCatalog, readReferenceCatalog, referenceDates } from './catalog.js';
import { classifyBookingResponse } from './booking-outcome.js';
import { SessionExpiredError, RequestNotSentError } from './errors.js';
import { matchesCourtSelection } from './planner.js';
import { BookingQuota } from './booking-quota.js';
import { schoolBookingScope } from './booking-review.js';
import { validateBookingGoal, bookingGoal, goalReached, goalAllows, adjacent } from './booking-goal.js';
import { addDays, mapLimit, releaseEpoch, shanghaiDate, sleep } from './utils.js';
import { estimateServerClock } from './server-clock.js';

export function bookingReleaseAt(date) {
  return releaseEpoch(addDays(date, -1), '12:30:00');
}

export function validateExecutionStart(mode, date, now = Date.now()) {
  if (!['release', 'now', 'check'].includes(mode)) throw new Error('已移除系统定时，请手动开始本次执行');
  if (mode === 'check') return now;
  const release = bookingReleaseAt(date);
  if (mode === 'now') {
    if (release > now) throw new Error('尚未放号，请在放号当天启动倒计时');
    return now;
  }
  if (release <= now) throw new Error('放号时间已过，请选择立即尝试');
  if (shanghaiDate(release) !== shanghaiDate(now)) throw new Error('请在放号当天登录并启动倒计时；方案已保存，无需提前守候');
  return release;
}

export function executionIntent(mode, date, { confirmedAt = Date.now(), now = Date.now(), durationMs = 120000 } = {}) {
  const chosen = mode === 'auto' ? (bookingReleaseAt(date) > confirmedAt ? 'release' : 'now') : mode;
  const releaseAt = validateExecutionStart(chosen, date, confirmedAt);
  if (chosen === 'release' && now >= releaseAt + durationMs) {
    throw new Error('登录验证期间已错过本次执行窗口，请重新确认立即尝试');
  }
  return { mode: chosen, releaseAt };
}

export function slotStartAt(date, time) {
  return Date.parse(`${date}T${time.split('-')[0]}:00+08:00`);
}

export async function waitForRelease({ api, scheduler, immediate, log, signal, releaseAtServer,
  onState = () => {}, prepare, prepareLeadMs = 15000 }) {
  signal?.throwIfAborted();
  const intervalClock = typeof api.sampleServerClock === 'function';
  // Production adapters support interval samples. Legacy immediate adapters
  // without this API cannot establish a release correction.
  if (immediate && !intervalClock) return { serverOffsetMs: 0, releaseAt: Date.now() };
  if (releaseAtServer === undefined) {
    releaseAtServer = releaseEpoch(shanghaiDate(), '12:30:00');
    if (!immediate && releaseAtServer <= Date.now()) throw new Error('放号时间已过，请明确选择立即预约');
  }
  let clock;
  if (intervalClock) {
    clock = await estimateServerClock(api, { signal, intervalMs: 200,
      // The local clock may already be past release while the school is not.
      // Leave enough sampling time to discover that instead of a 1 ms budget.
      deadline: Date.now() + Math.min(6000, Math.max(1500, releaseAtServer - Date.now() - 300)) });
  } else {
    const offsets = [];
    for (let i = 0; i < 3; i++) {
      signal?.throwIfAborted();
      offsets.push(await api.sampleServerOffset());
      if (i < 2) await sleep(80, signal);
    }
    offsets.sort((a, b) => a - b);
    if (!Number.isFinite(offsets[1])) throw new Error('学校服务器时钟校准失败');
    clock = { reliable: true, offsetMs: offsets[1] };
  }
  let serverOffsetMs = clock.offsetMs;
  let releaseAt = releaseAtServer - serverOffsetMs;
  if (immediate) releaseAt = Math.max(releaseAt, Date.now());
  const reportClock = (phase) => log(clock.reliable && !clock.partial ? 'INFO' : 'WARN', clock.reliable
    ? clock.partial ? '部分校时采样失败，保留已取得的有效学校时钟估计' : '已估计学校时钟偏差，等待设定的开始时间'
    : clock.boundOnly ? '学校新时钟样本不足，按有效样本的保守边界等待' : '学校时钟样本不可用，按本机时钟等待',
  { event: 'clock_estimate', phase, serverOffsetMs: Math.round(serverOffsetMs),
    uncertaintyMs: clock.uncertaintyMs, samples: clock.sampleCount, minRttMs: clock.minRttMs,
    reason: clock.reason ?? clock.sampleFailure, discardedPrior: clock.discardedPrior });
  reportClock('initial');
  onState('waiting', { releaseAt });
  let prepared = false, rechecked = !intervalClock;
  while (Date.now() < releaseAt) {
    if (prepare && !prepared && releaseAt - Date.now() <= prepareLeadMs) {
      prepared = true; await prepare({ releaseAt, serverOffsetMs }); signal?.throwIfAborted();
      continue;
    }
    if (!rechecked && (!prepare || prepared) && releaseAt - Date.now() <= 3000) {
      rechecked = true;
      const fresh = await estimateServerClock(api, { signal, maxSamples: 3, intervalMs: 200,
        adaptiveBoundary: true, priorEstimate: clock, deadline: releaseAt - 300 });
      if (fresh.reliable) {
        clock = fresh;
        serverOffsetMs = clock.offsetMs;
        releaseAt = releaseAtServer - serverOffsetMs;
        onState('waiting', { releaseAt });
      } else if (fresh.discardedPrior) {
        // Once contradicted, the previous estimate is no longer evidence. A
        // single fresh interval can still provide a conservative release bound.
        if (!Number.isFinite(fresh.lowerOffsetMs)) throw new Error('学校时钟样本相互矛盾，无法确认放号时间，请重新启动');
        clock = { ...fresh, boundOnly: true };
        serverOffsetMs = fresh.lowerOffsetMs;
        releaseAt = releaseAtServer - serverOffsetMs;
        onState('waiting', { releaseAt });
        log('WARN', '学校时钟估计发生变化，按新样本的保守边界等待放号',
          { event: 'clock_refresh_failed', reason: fresh.reason, uncertaintyMs: fresh.uncertaintyMs });
      } else log('WARN', '临近放号校时未取得有效样本，沿用此前时钟估计',
        { event: 'clock_refresh_failed', reason: fresh.reason });
      reportClock('release');
      continue;
    }
    const remaining = releaseAt - Date.now();
    const nextEvent = Math.max(prepare && !prepared ? prepareLeadMs : 0, !rechecked ? 3000 : 0);
    const next = remaining - nextEvent;
    const precisionWait = remaining <= 50 ? 1 : remaining <= 200 ? 5 : remaining <= 1000 ? 50 : 60_000;
    await sleep(Math.min(Math.max(1, next), precisionWait), signal);
    if (releaseAt - Date.now() > 60_000) {
      try { await api.getAvailableDates({ signal, deadline: Date.now() + 1000 }); }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof SessionExpiredError) throw error;
        log('WARN', '等待期间只读保活失败，临近放号会重新核验登录', { message: error.message });
      }
    }
  }
  if (prepare && !prepared) await prepare({ releaseAt, serverOffsetMs });
  signal?.throwIfAborted();
  return { serverOffsetMs, releaseAt: immediate ? Math.max(releaseAt, Date.now()) : releaseAt, clock };
}

export async function runBooking({ api, client, config, targets, date, immediate, live, log,
  signal, releaseAtServer, onState = () => {}, onSuccess = async () => {}, initialSuccesses = [],
  resetDurationOnStart = false, latestStartAt = Infinity, quota = new BookingQuota(), quotaAccount = 'current',
  loadSchoolBookings, readReference = readReferenceCatalog, onPreparedAttempt = async () => {} }) {
  const { scheduler } = config;
  let serverOffsetMs = 0;
  let clockReady = typeof api.sampleServerClock !== 'function';
  const schoolNow = () => Date.now() + serverOffsetMs;
  const localSlotDeadline = (task) => slotStartAt(task.date, task.time) - serverOffsetMs;
  const successes = [];
  const completed = new Map();
  let fatalError;
  let round = 0;
  let total = 0;
  let tasks = [];
  let requestSequence = 0;
  let firstAttemptAt;
  let releaseBlocked = false;
  let deliveredResult;
  const closeScopes = [];
  const metrics = { queries: 0, queryFailures: 0, attempts: 0, dispatched: 0, successes: 0, wait: 0, retry: 0, unknown: 0 };
  const quotaKey = (task) => quota.key(quotaAccount, task.target.sportCode, task.date);
  const expiredTasks = new Set();
  const conflicts = new Set();
  const accountErrors = () => new Map(tasks.map((task) => [quotaKey(task), quota.error(quotaKey(task))])
    .filter(([, message]) => message !== undefined));
  const wins = new Map(targets.map((target) => [target, new Set()]));
  const reached = (task) => goalReached(task.target, wins.get(task.target));
  const allows = (task, submitting = false) => {
    if (task.target.bookingGoal !== 'consecutive') return goalAllows(task.target, wins.get(task.target), task.time);
    const eligible = tasks.filter((other) => other.target === task.target && !expiredTasks.has(other.key) && !conflicts.has(other.key)
      && !quota.conflict(quotaKey(other), other.time)
      && (!quota.get(quotaKey(other), other.time) || matchesCourtSelection(other.target, quota.get(quotaKey(other), other.time).room))
      && (!live || !clockReady || completed.has(other.key) || quota.get(quotaKey(other), other.time) || schoolNow() < slotStartAt(other.date, other.time)));
    const won = wins.get(task.target);
    if (!goalAllows(task.target, won, task.time, eligible.map((other) => other.time))) return false;
    if (!submitting || !live || won.size) return true;
    // A new pair needs two free slots; a matching existing candidate can supply
    // one side. Reusing an order is distinct from spending a remaining slot.
    return eligible.some((other) => other.time !== task.time && adjacent(other.time, task.time)
      && Number(!quota.get(quotaKey(task), task.time)) + Number(!quota.get(quotaKey(other), other.time)) <= quota.remaining(quotaKey(task)));
  };
  const done = (task) => completed.has(task.key) || expiredTasks.has(task.key) || conflicts.has(task.key)
    || reached(task) || !allows(task, true)
    || quota.full(quotaKey(task)) || quota.error(quotaKey(task));
  const expire = (task) => {
    if (live && clockReady && !completed.has(task.key) && schoolNow() >= slotStartAt(task.date, task.time)) {
      if (!expiredTasks.has(task.key)) log('INFO', `时段已开始，跳过：${task.target.name} / ${task.time}`);
      expiredTasks.add(task.key);
    }
    return expiredTasks.has(task.key);
  };
  const fulfilled = (task) => completed.has(task.key) || reached(task);
  const result = (extra = {}) => ({ ok: accountErrors().size === 0 && total > 0 && tasks.every(fulfilled),
    successes, total, rounds: round,
    limited: tasks.some((t) => !completed.has(t.key) && quota.full(quotaKey(t))),
    expired: expiredTasks.size > 0, expiredTimes: tasks.filter((t) => expiredTasks.has(t.key)).map((t) => t.time),
    dryRun: !live, metrics: { ...metrics },
    slots: tasks.map((task) => ({ time: task.time, sportCode: task.target.sportCode,
      status: completed.has(task.key) ? 'success' : conflicts.has(task.key) ? 'conflict' : expiredTasks.has(task.key) ? 'expired'
        : reached(task) ? 'goal_reached' : quota.error(quotaKey(task)) ? 'error'
          : quota.full(quotaKey(task)) ? 'limited' : !allows(task, true) ? 'ineligible' : 'unfilled',
      lastOutcome: task.lastOutcome, lastMessage: task.lastMessage ?? (allows(task) && !allows(task, true)
        ? '剩余名额不足以完成连续两段' : undefined) })),
    ...((accountErrors().size || tasks.some((t) => conflicts.has(t.key) && !reached(t)))
      ? { error: [...accountErrors().values(), ...tasks.filter((t) => conflicts.has(t.key) && !reached(t)).map((t) => `${t.time}：${t.lastMessage}`)].join('；') } : {}), ...extra });
  const deliver = (extra) => (deliveredResult = result(extra));
  const reuse = async (task, existing = quota.get(quotaKey(task), task.time)) => {
    if (completed.has(task.key)) return;
    const overlap = quota.conflict(quotaKey(task), task.time);
    if (overlap) {
      conflicts.add(task.key); task.lastMessage = `已有预约 ${overlap} 与此候选重叠，不重复提交`; return;
    }
    if (!existing || !allows(task)) return;
    if (!existing.room) {
      conflicts.add(task.key); task.lastMessage = '学校已有此时段预约，但无法识别场地，请人工核对'; return;
    }
    const allowed = matchesCourtSelection(task.target, existing.room);
    if (!allowed) {
      if (!conflicts.has(task.key)) log('WARN', `此时段已约 ${existing.room.CDMC}，不符合本方案场地选择，不重复提交`, { event: 'booking_conflict', date, time: task.time });
      conflicts.add(task.key);
      task.lastMessage = `已约 ${existing.room.CDMC}，不符合本方案场地选择`;
      return;
    }
    completed.set(task.key, existing.room); expiredTasks.delete(task.key); wins.get(task.target).add(task.time);
    const success = { task: { ...task, room: existing.room }, response: existing.response, reused: true, school: Boolean(existing.school) };
    successes.push(success);
    log('OK', `${existing.school ? '学校已有预约' : '本批次其他方案已约到'}：${task.time} / ${existing.room.CDMC}，不重复提交`, { event: 'booking_reused', time: task.time, date });
    await onSuccess(success);
  };
  try {
    signal?.throwIfAborted();
    targets.forEach((target) => validateBookingGoal({ ...target, date }));
    const batches = targets.map((target) => [...new Set(target.times)].sort().map((time, timeIndex) => ({
      target, date, time, timeIndex, rooms: [], key: `${target.targetIndex}|${date}|${time}`,
    })));
    tasks = batches.flat(); total = tasks.length;
    if (!total) throw new Error('没有可执行的预约时段');
    if (live) for (const key of new Set(tasks.map(quotaKey))) closeScopes.push(quota.open(key));
    log('PLAN', '本次执行规则：候选时段、场地顺序与同场偏好', {
      event: 'execution_plan', date, live, immediate,
      targets: targets.map((t) => ({ name: t.name, times: [...new Set(t.times)].sort(),
        courts: t.courtNames, bookingGoal: bookingGoal(t), preferSameCourt: Boolean(t.preferSameCourt), includeOtherCourts: Boolean(t.includeOtherCourts) })),
      pollIntervalMs: scheduler.pollIntervalMs, timeoutMs: scheduler.timeoutMs,
    });
    for (const prior of initialSuccesses) {
      const task = tasks.find((t) => t.date === prior.date && t.time === prior.time
        && (!(prior.sportCode ?? prior.room?.XMDM) || t.target.sportCode === (prior.sportCode ?? prior.room?.XMDM)));
      if (!task || completed.has(task.key)) continue;
      if (!prior.room) throw new Error('无法识别上次已成功场地，请人工核对后重建剩余时段');
      completed.set(task.key, prior.room); quota.seed(quotaKey(task), task.time,
        { room: prior.room, response: { code: '0', data: { DHID: prior.orderId } } });
      wins.get(task.target).add(task.time);
      successes.push({ task: { ...task, room: prior.room }, response: { code: '0', data: { DHID: prior.orderId } } });
    }
    if (live) for (const task of tasks) await reuse(task);
    tasks.forEach(expire);
    if (live && tasks.every(done) && (!loadSchoolBookings || tasks.every((task) =>
      expiredTasks.has(task.key) || completed.has(task.key) || reached(task)
        || quota.full(quotaKey(task)) || quota.error(quotaKey(task))))) return deliver();
    let deadline = Infinity;
    let prepared = false;
    async function prepareSchool(queryDeadline = deadline) {
      if (loadSchoolBookings) {
        for (const target of targets) {
          const key = quota.key(quotaAccount, target.sportCode, date);
          try { await quota.prepare(key, async () => {
            const scope = schoolBookingScope({ date, target, rows: await loadSchoolBookings({ signal, deadline: queryDeadline }) });
            if (scope.unresolved.length) throw new Error('学校预约记录存在无法确认的状态或字段，请先人工核对后再执行');
            for (const slot of scope.bookings) {
              const room = slot.courtId || slot.court !== '学校已约场地'
                ? { WID: slot.courtId, CDMC: slot.court, XMDM: target.sportCode,
                  CGBM: slot.venueCode, XQDM: slot.campusCode, YYLX: slot.modeCode } : null;
              quota.seed(key, slot.time, { room, school: true, response: { code: '0' } });
            }
          }, { signal, deadline: queryDeadline, onRetry: ({ attempt, delayMs, message }) =>
            log('WARN', `${target.name}：只读预约核对暂时失败，稍后重试`,
              { event: 'booking_preflight_retry', date, sportCode: target.sportCode, attempt, delayMs, message }) }); } catch (error) {
            log('ERROR', `${target.name}：${error.message}`, { event: 'booking_preflight_error', date, sportCode: target.sportCode });
          }
          signal?.throwIfAborted();
        }
        for (const task of tasks) await reuse(task);
      }
      tasks.forEach(expire);
      prepared = true;
    }
    if (live) {
      // The saved "now" intent stores confirmation time, not the school's
      // scheduled release. Correct against the actual release for this date.
      if (immediate || releaseAtServer === undefined) releaseAtServer = bookingReleaseAt(date);
      const release = await waitForRelease({ api, scheduler, immediate, log, signal, releaseAtServer, onState,
        prepare: async ({ releaseAt, serverOffsetMs: offsetMs }) => {
          serverOffsetMs = offsetMs; clockReady = true;
          deadline = releaseAt + scheduler.timeoutMs;
          const remaining = releaseAt - Date.now();
          const prepareDeadline = remaining > 3000 ? releaseAt - 3000 : remaining > 100 ? releaseAt - 100 : deadline;
          log('INFO', immediate && releaseAt <= Date.now() ? '开始前复核登录与学校订单'
            : '临近放号，复核登录与订单，预读候选时段并准备首单；到点才提交');
          if (api.getIdentity) {
            try { await api.getIdentity({ refresh: true, signal, deadline: prepareDeadline }); }
            catch (error) {
              if (error instanceof SessionExpiredError) for (const task of tasks) quota.stop(quotaKey(task), error.message);
              throw error;
            }
          }
          await prepareSchool(prepareDeadline);
          // Prepare every candidate while there is time, so a successful first
          // slot need not wait for the next slot's catalog after release.
          const warmupUntil = releaseAt - (releaseAt - Date.now() > 3000 ? 3000 : 100);
          for (const task of tasks) {
            if (Date.now() >= warmupUntil) break;
            if (!done(task)) await loadRooms([task], { warmupUntil });
          }
          const first = tasks.find((task) => task.warmed && !done(task));
          const room = first && candidateRooms(first).rooms[0];
          if (room && Date.now() < releaseAt) await onPreparedAttempt({ date, modeCode: first.target.modeCode,
            time: first.time, room, deadline: Math.min(deadline, localSlotDeadline(first)) });
        } });
      serverOffsetMs = release.serverOffsetMs; clockReady = true;
      // A late clock refinement can move a candidate's school start boundary.
      expiredTasks.clear(); tasks.forEach(expire);
      const { releaseAt } = release;
      if (Date.now() > latestStartAt) return deliver({ missed: true });
      deadline = (immediate && resetDurationOnStart ? Math.max(Date.now(), releaseAt) : releaseAt) + scheduler.timeoutMs;
      if (Date.now() >= deadline) return deliver({ missed: true });
      onState('booking', { deadline });
      log('INFO', immediate ? '开始立即预约' : '已到设定时间，开始预约');
      if (!prepared) await prepareSchool();
      if (tasks.every(done)) return deliver();
    }
    async function loadRooms(batch, { warmupUntil, attemptReady = false } = {}) {
      const pending = batch.filter((task) => !expire(task) && !done(task));
      if (!pending.length && live) return;
      const target = batch[0].target;
      const previousRooms = new Map(batch.map((task) => [task.key, task.rooms]));
      try {
        const input = { api, target, date,
          times: (live ? pending : batch).map((t) => t.time),
          signal, deadline: warmupUntil ?? deadline,
          timeoutMs: warmupUntil ? Math.max(1, Math.min(1000, warmupUntil - Date.now())) : undefined,
          partialOnDeadline: Boolean(warmupUntil),
          tolerateUnavailable: live,
          // Submit early only when this partial catalog contains the actual
          // first choice. A lower-priority venue must not steal that priority.
          onRooms: attemptReady ? async ({ time, rooms }) => {
            const task = pending.find((candidate) => candidate.time === time);
            if (!task || !rooms.length) return;
            task.rooms = rooms; task.lastRefresh = Date.now();
            const choice = candidateRooms(task);
            const preferredNeighbor = task.target.preferSameCourt && choice.neighbor;
            const savedAnchor = choice.anchor;
            const neighborRoom = preferredNeighbor && completed.get(choice.neighbor.key);
            // A partial multi-venue view cannot establish a unique name-only
            // match until every venue has been checked.
            if (task.target.venues.length > 1 && ((neighborRoom && !neighborRoom.WID && !neighborRoom.CGBM)
              || (savedAnchor && !savedAnchor.courtId && !savedAnchor.venueCode))) return;
            if ((preferredNeighbor || savedAnchor) && !choice.preferred) return;
            const firstChoice = task.target.courtNames?.[0];
            if (!choice.preferred && firstChoice && ![choice.rooms[0].WID, choice.rooms[0].CDMC].includes(firstChoice)) return;
            await attempt(task);
            if (done(task) || releaseBlocked || Date.now() >= deadline) return false;
          } : undefined,
          onQuery: (details) => {
            metrics.queries++;
            if (['unavailable', 'error'].includes(details.outcome)) metrics.queryFailures++;
            log(details.message ? 'WARN' : 'QUERY', `读取场地：${target.name} / ${details.time}${details.message ? ' · ' + details.message : ''}`,
              { event: 'catalog_query', round, date, targetIndex: target.targetIndex, ...details });
          } };
        const catalog = live ? await readCourtCatalog(input)
          : await readReference({ ...input, dates: referenceDates(date), tolerateUnavailable: true });
        for (const task of batch) {
          // Reference catalogs may merge dates/times. Live views stay scoped to
          // this slot; an empty first slot must not borrow the later slot's rooms.
          const rooms = live ? catalog.roomsByTime[task.time] ?? [] : catalog.rooms;
          const transientVenues = new Set(catalog.issues.filter((i) => i.time === task.time && i.transient).map((i) => i.venue));
          task.rooms = [...rooms, ...(previousRooms.get(task.key) ?? []).filter((room) => transientVenues.has(room.CGBM)
            && !rooms.some((r) => r.WID === room.WID))];
          if (!task.rooms.length) {
            const issue = catalog.issues.find((i) => i.time === task.time);
            task.lastOutcome = issue ? 'query_unavailable' : 'empty_catalog';
            task.lastMessage = issue?.message;
          }
          task.lastRefresh = Date.now();
          task.warmed = Boolean(warmupUntil && rooms.length);
        }
      } catch (error) {
        if (!signal?.aborted && error.code === 'REQUEST_NOT_SENT' && Date.now() >= deadline) return;
        if (live && (error instanceof SessionExpiredError || ['account', 'rejected'].includes(error.outcome?.kind))) {
          quota.stop(quotaKey(batch[0]), error.message);
          for (const task of batch) { task.lastOutcome = error.outcome?.kind ?? 'account'; task.lastMessage = error.message; }
          return;
        }
        throw error;
      }
    }
    if (!live) await mapLimit(batches, scheduler.queryConcurrency, (batch) => loadRooms(batch));
    signal?.throwIfAborted();
    if (!live) {
      const missing = tasks.find((task) => !task.rooms.length);
      if (missing) throw new Error(`[${missing.target.name}] 暂未读到匹配场地；可刷新参考目录，正式执行会在窗口内重试`);
      log('CHECK', '检查通过：已读取场地目录，未提交预约；开放情况以学校系统为准');
      return deliver({ ok: true, executionTasks: tasks });
    }
    function candidateRooms(task) {
      const neighbor = tasks.filter((candidate) => candidate.target === task.target && completed.has(candidate.key)
        && adjacent(candidate.time, task.time)).sort((a, b) => a.time.localeCompare(b.time))[0];
      const bookedRoom = task.target.preferSameCourt && neighbor ? completed.get(neighbor.key) : null;
      const savedAnchor = task.target.sameCourtAnchor;
      const anchorOrder = savedAnchor && quota.get(quotaKey(task), savedAnchor.time)?.room;
      const anchor = task.target.preferSameCourt && savedAnchor?.date === date && adjacent(savedAnchor.time, task.time)
        && (!loadSchoolBookings || (anchorOrder && (savedAnchor.courtId
          ? savedAnchor.courtId === anchorOrder.WID : savedAnchor.court === anchorOrder.CDMC))) ? savedAnchor : null;
      const neighborMatches = bookedRoom ? task.rooms.filter((room) => bookedRoom.WID
        ? room.WID === bookedRoom.WID : room.CDMC === bookedRoom.CDMC
          && (!bookedRoom.CGBM || room.CGBM === bookedRoom.CGBM)) : [];
      const anchorMatches = anchor ? task.rooms.filter((room) => anchor.courtId
        ? room.WID === anchor.courtId : room.CDMC === anchor.court && (!anchor.venueCode || room.CGBM === anchor.venueCode)) : [];
      const preferred = bookedRoom ? neighborMatches.length === 1 ? neighborMatches[0] : null
        : anchorMatches.length === 1 ? anchorMatches[0] : null;
      const rooms = preferred ? [preferred, ...task.rooms.filter((room) => room.WID !== preferred.WID)] : task.rooms;
      return { rooms, preferred, neighbor, anchor };
    }
    const attempt = async (task) => {
      task.warmed = false;
      signal?.throwIfAborted();
      await reuse(task);
      if (releaseBlocked || expire(task) || done(task) || !allows(task)) return;
      if (task.attemptedRound !== round) { task.attemptedRound = round; task.attemptedRooms = new Set(); }
      const { rooms, preferred, neighbor, anchor } = candidateRooms(task);
      const choice = { event: 'court_order', round, targetIndex: task.target.targetIndex, date, time: task.time,
        courts: rooms.map((r) => r.CDMC), reason: preferred ? 'same_court' : 'configured_order',
        neighborTime: preferred ? neighbor?.time ?? anchor?.time : undefined };
      if (task.choiceSignature !== JSON.stringify(choice.courts.concat(choice.reason, choice.neighborTime))) {
        task.choiceSignature = JSON.stringify(choice.courts.concat(choice.reason, choice.neighborTime));
        log('PLAN', `尝试顺序：${task.target.name} / ${task.time}${preferred ? ` · 优先已约时段 ${choice.neighborTime} 的 ${preferred.CDMC}` : ' · 按原场地顺序'}`, choice);
      }
      for (const room of rooms) {
        if (task.attemptedRooms.has(room.WID)) continue;
        signal?.throwIfAborted();
        if (fatalError) throw fatalError;
        if (Date.now() >= deadline || expire(task) || done(task)) return;
        task.attemptedRooms.add(room.WID);
        const label = `${task.target.name} / ${task.time} / ${room.CDMC}`;
        const queuedAt = Date.now();
        const requestId = `${task.target.targetIndex}:${++requestSequence}`;
        // Wait for an already sent request so its result is not lost on Stop.
        const response = await quota.attempt(quotaKey(task), task.time, async () => {
          signal?.throwIfAborted();
          if (fatalError) throw fatalError;
          if (releaseBlocked) return { code: '1', msg: '预约时间未到' };
          if (expire(task)) return { code: 'SLOT_EXPIRED', msg: '时段已开始' };
          if (!allows(task, true)) return { code: 'GOAL_REACHED', msg: allows(task) ? '剩余名额不足以完成连续两段' : '此时段不符合剩余预约目标' };
          if (quota.error(quotaKey(task))) return { code: 'LOCAL_ACCOUNT_STOPPED', msg: quota.error(quotaKey(task)) };
          if (Date.now() >= deadline) return { code: 'EXPIRED', msg: '执行窗口已结束' };
          const startedAt = Date.now();
          firstAttemptAt ??= startedAt;
          metrics.attempts++;
          const requestDetails = { requestId, round, targetIndex: task.target.targetIndex, date, time: task.time,
            court: room.CDMC, reason: preferred?.WID === room.WID ? 'same_court'
              : task.target.courtNames && !task.target.courtNames.includes(room.WID) && !task.target.courtNames.includes(room.CDMC)
                ? 'other_court' : 'configured_order',
            quotaQueueMs: startedAt - queuedAt, firstAttemptAt };
          log('REQUEST', `准备提交：${label}`, { event: 'booking_request', ...requestDetails });
          try {
            const beforeDispatch = () => {
              if (signal?.aborted) throw new RequestNotSentError('本次执行已停止，未发送请求');
              const blocked = quota.error(quotaKey(task)) ? { code: 'LOCAL_ACCOUNT_STOPPED', msg: quota.error(quotaKey(task)) }
                : expire(task) ? { code: 'SLOT_EXPIRED', msg: '时段已开始' }
                  : !allows(task, true) ? { code: 'GOAL_REACHED', msg: allows(task) ? '剩余名额不足以完成连续两段' : '此时段不符合剩余预约目标' }
                    : quota.full(quotaKey(task)) ? { code: 'LOCAL_DAILY_LIMIT', msg: '已达当天两时段上限' } : null;
              if (blocked) throw Object.assign(new RequestNotSentError(blocked.msg), { bookingResponse: blocked });
            };
            const response = await api.book({ date, modeCode: task.target.modeCode, room, time: task.time, requestId,
              deadline: Math.min(deadline, localSlotDeadline(task)), signal, beforeDispatch,
              onDispatch: ({ startedAt: sentAt }) => {
                metrics.dispatched++;
                log('REQUEST', `已调用预约传输：${label}`, { event: 'booking_dispatch', ...requestDetails,
                  sentAt, dispatchDelayMs: sentAt - startedAt });
              } });
            const outcome = classifyBookingResponse(response);
            if (outcome.kind === 'wait' && outcome.scope === 'release') releaseBlocked = true;
            if (outcome.kind === 'success') {
              metrics.successes++; wins.get(task.target).add(task.time);
              quota.seed(quotaKey(task), task.time, { room, response });
            }
            if (['wait', 'retry'].includes(outcome.kind)) metrics[outcome.kind]++;
            task.lastOutcome = outcome.kind; task.lastMessage = outcome.message;
            log(outcome.kind === 'success' ? 'OK' : 'WARN', `提交结果：${label} · ${outcome.kind === 'success' ? '成功' : outcome.message}`,
              { event: 'booking_response', ...requestDetails, totalDurationMs: Date.now() - startedAt, durationMs: Date.now() - startedAt,
                ...response.requestTiming, code: response.code, outcome: outcome.kind, message: outcome.message });
            if (response.persistenceError) {
              quota.stop(quotaKey(task), `登录状态保存失败，已停止此账号项目的提交：${response.persistenceError}`);
            }
            if (['account', 'rejected'].includes(outcome.kind)) quota.stop(quotaKey(task), outcome.message);
            return response;
          } catch (error) {
            const unknown = error.code !== 'REQUEST_NOT_SENT';
            if (unknown) metrics.unknown++;
            task.lastOutcome = unknown ? 'unknown' : 'not_sent'; task.lastMessage = error.message;
            log('ERROR', `提交异常：${label} · ${error.message}`, { event: 'booking_error', ...requestDetails,
              durationMs: Date.now() - startedAt, outcome: task.lastOutcome, message: error.message });
            // Record failure before releasing the quota queue: sibling slots may
            // already be queued and must not dispatch after an unknown result.
            if (error.code === 'REQUEST_NOT_SENT' && error.bookingResponse) return error.bookingResponse;
            if (error.code === 'REQUEST_NOT_SENT' && expire(task)) return { code: 'SLOT_EXPIRED', msg: '时段已开始' };
            if (error.code === 'REQUEST_NOT_SENT') {
              if (!signal?.aborted) fatalError ??= error;
            } else {
              fatalError ??= error instanceof SessionExpiredError ? error
                : new Error(`预约结果待确认：${label}。请查看学校“我的预约”后再操作。${error.message}`);
              quota.stop(quotaKey(task), fatalError.message);
            }
            throw fatalError ?? error;
          }
        });
        if (response.code === 'LOCAL_SLOT_BOOKED') { await reuse(task, response.existing); return; }
        if (response.code === 'LOCAL_SLOT_CONFLICT') {
          conflicts.add(task.key); task.lastMessage = response.msg; return;
        }
        if (response.code === 'GOAL_REACHED') return;
        const outcome = classifyBookingResponse(response);
        if (outcome.kind === 'limited') return;
        if (outcome.kind === 'expired' || (outcome.kind === 'deadline' && expire(task))) {
          expiredTasks.add(task.key); return;
        }
        if (outcome.kind === 'deadline') return;
        if (outcome.kind === 'account' || outcome.kind === 'rejected') {
          quota.stop(quotaKey(task), outcome.message);
          log('ERROR', outcome.message); return;
        }
        // "Not open" may describe just this court. It must not hide the next
        // configured court or prevent the later slots from being attempted.
        if (outcome.kind === 'wait') {
          if (outcome.scope === 'release') return;
          continue;
        }
        if (outcome.kind === 'success') {
          completed.set(task.key, room);
          const success = { task: { ...task, room }, response };
          successes.push(success);
          log('OK', `预约成功：${label}`, { orderId: response.data?.DHID });
          await onSuccess(success);
          return;
        }
        log('WARN', `未成功：${label}`, { message: response.msg });
      }
    };
    while (Date.now() <= deadline && tasks.some((task) => !done(task))) {
      signal?.throwIfAborted();
      tasks.forEach(expire);
      if (tasks.every(done)) break;
      round++;
      releaseBlocked = false;
      // Finish the preferred query -> submit chain before other slot queries
      // enter this account's FIFO transport queue, even without warmup.
      const first = tasks.find((task) => !expire(task) && !done(task));
      if (first && Date.now() < deadline) {
        if (!first.rooms.length || (!first.warmed && Date.now() - (first.lastRefresh ?? 0) >= 5000)) {
          await loadRooms([first], { attemptReady: true });
        }
        if (!completed.has(first.key) && !releaseBlocked) await attempt(first);
      }
      const lanes = batches.flatMap((batch) => batch[0].target.preferSameCourt ? [batch] : batch.map((task) => [task]));
      await mapLimit(lanes, Math.min(config.booking.taskConcurrency ?? 4, scheduler.queryConcurrency), async (lane) => {
        for (let i = 0; i < lane.length; i++) {
          const task = lane[i];
          if (task === first || releaseBlocked) continue;
          await reuse(task);
          if (expire(task) || done(task) || Date.now() >= deadline) continue;
          // Query and try each slot promptly instead of waiting for all later
          // catalogs. Empty views retry; populated views refresh every 5 seconds.
          if (!task.rooms.length || (!task.warmed && Date.now() - (task.lastRefresh ?? 0) >= 5000)) await loadRooms([task]);
          await attempt(task);
        }
      });
      if (tasks.some((task) => !done(task))) await sleep(Math.min(deadline - Date.now(), scheduler.pollIntervalMs
        + Math.floor(Math.random() * ((scheduler.pollJitterMs ?? 0) + 1))), signal);
    }
    for (const task of tasks) await reuse(task);
    signal?.throwIfAborted();
    if (result().limited) log('INFO', '同一账号、项目、日期已成功两个时段，剩余时段停止尝试');
    log(tasks.every(done) ? 'OK' : 'WARN', `预约结束：${completed.size}/${total} 个时段成功`);
    if (!successes.length && tasks.some((task) => !done(task) && !task.rooms.length)) {
      const message = '执行窗口内学校未返回所选场地，请核对目标日期、场地目录和学校开放状态';
      log('WARN', message);
      return deliver({ error: message });
    }
    return deliver();
  } catch (error) {
    if (signal?.aborted) {
      if (fatalError) log('ERROR', fatalError.message);
      return deliver({ stopped: true, ...(fatalError ? { ok: false, error: fatalError.message } : {}) });
    }
    log('ERROR', error.message);
    return deliver({ ok: false, error: error.message });
  } finally {
    log('SUMMARY', '本次执行统计', { event: 'execution_summary', rounds: round, ...metrics, slots: result().slots });
    try {
      await client.flush();
    } catch (error) {
      const message = `登录状态保存失败，已停止本次执行：${error.message}`;
      for (const task of tasks) quota.stop(quotaKey(task), message);
      log('ERROR', message, { event: 'execution_flush_error', outcome: 'persistence_error', message: error.message });
      if (!deliveredResult) throw error;
      // A final local flush must not erase the school's known response or turn
      // it into an unknown POST outcome. Let adapters halt storage-dependent
      // sibling work while retaining this run's successes and metrics.
      Object.assign(deliveredResult, { ok: false, persistenceError: error.message,
        error: deliveredResult.error ? `${deliveredResult.error}；${message}` : message });
    } finally { closeScopes.forEach((close) => close()); }
  }
}

export function defaultTargetDate(config, nowMs = Date.now()) {
  if (config.scheduler.targetDate === 'tomorrow') return addDays(shanghaiDate(nowMs), 1);
  if (config.scheduler.targetDate === 'today') return shanghaiDate(nowMs);
  return config.scheduler.targetDate;
}
