import { compareTasks, roomsToTasks } from './planner.js';
import { SessionExpiredError } from './errors.js';
import { BookingQuota } from './booking-quota.js';
import { addDays, mapLimit, releaseEpoch, shanghaiDate, sleep } from './utils.js';

export function bookingReleaseAt(date) {
  return releaseEpoch(addDays(date, -1), '12:30:00');
}

export async function waitForRelease({ api, scheduler, immediate, log, signal, releaseAtServer,
  onState = () => {} }) {
  signal?.throwIfAborted();
  if (immediate) return { serverOffsetMs: 0, releaseAt: Date.now() };
  if (releaseAtServer === undefined) {
    releaseAtServer = releaseEpoch(shanghaiDate(), '12:30:00');
    if (releaseAtServer <= Date.now()) throw new Error('放号时间已过，请明确选择立即预约');
  }
  const offsets = [];
  for (let i = 0; i < 3; i++) {
    signal?.throwIfAborted();
    offsets.push(await api.sampleServerOffset());
    if (i < 2) await sleep(80, signal);
  }
  offsets.sort((a, b) => a - b);
  const serverOffsetMs = offsets[1];
  if (!Number.isFinite(serverOffsetMs)) throw new Error('学校服务器时钟校准失败');
  const releaseAt = releaseAtServer - serverOffsetMs;
  log('INFO', '已校准时钟，等待设定的开始时间', { serverOffsetMs: Math.round(serverOffsetMs) });
  onState('waiting', { releaseAt });
  while (Date.now() < releaseAt) {
    await sleep(Math.min(releaseAt - Date.now(), 60_000), signal);
    if (releaseAt - Date.now() > 60_000) await api.getAvailableDates();
  }
  signal?.throwIfAborted();
  return { serverOffsetMs, releaseAt };
}

export async function runBooking({ api, client, config, targets, date, immediate, live, log,
  signal, releaseAtServer, onState = () => {}, onSuccess = async () => {}, initialSuccesses = [],
  resetDurationOnStart = false, latestStartAt = Infinity, quota = new BookingQuota(), quotaAccount = 'current' }) {
  const { scheduler } = config;
  const successes = [];
  const completed = new Map();
  let fatalError;
  let round = 0;
  let total = 0;
  let tasks = [];
  const quotaKey = (task) => quota.key(quotaAccount, task.target.sportCode, task.date);
  const done = (task) => completed.has(task.key) || quota.full(quotaKey(task));
  const result = (extra = {}) => ({ ok: total > 0 && tasks.every(done), successes, total, rounds: round,
    limited: tasks.some((task) => !completed.has(task.key) && quota.full(quotaKey(task))),
    dryRun: !live, ...extra });
  try {
    signal?.throwIfAborted();
    if (live && !immediate && releaseAtServer === undefined) {
      releaseAtServer = bookingReleaseAt(date);
      if (releaseAtServer <= Date.now()) throw new Error('放号时间已过，请明确选择立即预约');
    }
    const groups = targets.flatMap((target) => target.venues.map((venue, venueIndex) => ({
      target, date, time: target.times[0], timeIndex: 0, venue, venueIndex,
    })));
    const catalogs = await mapLimit(groups, scheduler.queryConcurrency, async (group) => {
      signal?.throwIfAborted();
      const rooms = await api.getOpeningRooms({ campusCode: group.target.campusCode,
        sportCode: group.target.sportCode, modeCode: group.target.modeCode,
        venueCode: group.venue.CGBM, date: shanghaiDate(), time: group.time });
      return roomsToTasks(group, rooms).sort(compareTasks);
    });
    const batches = targets.map((target) => {
      const unique = new Map(catalogs.flat().filter((task) => task.target === target)
        .map((task) => [task.room.WID, task.room]));
      const rooms = [...unique.values()];
      const rank = (room) => target.courtNames?.findIndex((value) => value === room.WID || value === room.CDMC) ?? 0;
      rooms.sort((a, b) => rank(a) - rank(b));
      return [...target.times].sort().map((time, timeIndex) => ({ target, date, time, timeIndex, rooms,
        key: `${target.targetIndex}|${date}|${time}` }));
    });
    tasks = batches.flat();
    total = tasks.length;
    for (const prior of initialSuccesses) {
      const task = tasks.find((t) => t.date === prior.date && t.time === prior.time
        && (!(prior.sportCode ?? prior.room?.XMDM) || t.target.sportCode === (prior.sportCode ?? prior.room?.XMDM)));
      if (!task || completed.has(task.key)) continue;
      const room = prior.room ?? task.rooms.find((r) => r.CDMC === prior.court);
      if (!room) throw new Error('无法识别上次已成功场地，请人工核对后重建剩余时段');
      completed.set(task.key, room);
      quota.seed(quotaKey(task), task.time);
      successes.push({ task: { ...task, room }, response: { code: '0', data: { DHID: prior.orderId } } });
    }
    if (!total || tasks.some((task) => !task.rooms.length)) throw new Error('没有匹配的场地，请重新选择场地或检查登录状态');
    for (const task of tasks) log('PLAN', `${task.target.name} / ${task.time}`, {
      courts: task.rooms.map((room) => room.CDMC), preferSameCourt: Boolean(task.target.preferSameCourt),
    });
    signal?.throwIfAborted();
    if (!live) {
      log('CHECK', '检查通过：已读取场地目录，未提交预约；开放情况以学校系统为准');
      return result({ ok: true, executionTasks: tasks });
    }
    const { releaseAt } = await waitForRelease({ api, scheduler, immediate, log, signal, releaseAtServer, onState });
    if (Date.now() > latestStartAt) return result({ missed: true });
    const deadline = (resetDurationOnStart ? Math.max(Date.now(), releaseAt) : releaseAt) + scheduler.timeoutMs;
    if (Date.now() > deadline) return result({ missed: true });
    onState('booking', { deadline });
    log('INFO', immediate ? '开始立即预约' : '已到设定时间，开始预约');
    const attempt = async (task, previous) => {
      signal?.throwIfAborted();
      if (done(task)) return;
      const adjacent = previous?.time.split('-')[1] === task.time.split('-')[0];
      const preferred = task.target.preferSameCourt && adjacent ? completed.get(previous.key) : null;
      const rooms = preferred ? [preferred, ...task.rooms.filter((room) => room.WID !== preferred.WID)] : task.rooms;
      for (const room of rooms) {
        signal?.throwIfAborted();
        if (fatalError) throw fatalError;
        if (Date.now() > deadline) return;
        const label = `${task.target.name} / ${task.time} / ${room.CDMC}`;
        let response;
        try {
          // Wait for an already sent request so its result is not lost on Stop.
          response = await quota.attempt(quotaKey(task), task.time, () => {
            signal?.throwIfAborted();
            if (Date.now() > deadline) return { code: 'EXPIRED', msg: '执行窗口已结束' };
            return api.book({ date, modeCode: task.target.modeCode, room, time: task.time, deadline });
          });
        } catch (error) {
          fatalError = error instanceof SessionExpiredError ? error
            : new Error(`预约结果待确认：${label}。请查看学校“我的预约”后再操作。${error.message}`);
          throw fatalError;
        }
        if (response.code === 'LOCAL_DAILY_LIMIT') return;
        if (response.code === '0') {
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
      round++;
      const lanes = batches.flatMap((batch) => batch[0].target.preferSameCourt ? [batch] : batch.map((task) => [task]));
      await mapLimit(lanes, config.booking.taskConcurrency ?? 4, async (lane) => {
        for (let i = 0; i < lane.length; i++) await attempt(lane[i], lane[i - 1]);
      });
      if (tasks.some((task) => !done(task))) await sleep(Math.min(deadline - Date.now(), scheduler.pollIntervalMs
        + Math.floor(Math.random() * ((scheduler.pollJitterMs ?? 0) + 1))), signal);
    }
    signal?.throwIfAborted();
    if (result().limited) log('INFO', '同一账号、项目、日期已成功两个时段，剩余时段停止尝试');
    log(tasks.every(done) ? 'OK' : 'WARN', `预约结束：${completed.size}/${total} 个时段成功`);
    return result();
  } catch (error) {
    if (signal?.aborted) return result({ stopped: true });
    log('ERROR', error.message);
    return result({ ok: false, error: error.message });
  } finally {
    await client.flush();
  }
}

export function defaultTargetDate(config, nowMs = Date.now()) {
  if (config.scheduler.targetDate === 'tomorrow') return addDays(shanghaiDate(nowMs), 1);
  if (config.scheduler.targetDate === 'today') return shanghaiDate(nowMs);
  return config.scheduler.targetDate;
}
