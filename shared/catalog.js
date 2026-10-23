import { roomsToTasks, compareTasks } from './planner.js';
import { RequestNotSentError, isTransientQueryError } from './errors.js';
import { splitTimeSlot, shanghaiDate, addDays } from './utils.js';

function check(signal, deadline) {
  signal?.throwIfAborted();
  if (Date.now() >= deadline) throw new RequestNotSentError('目录读取窗口已结束，未发送请求');
}

// Room queries are time-dependent views, not a complete physical-court table.
// Merge all requested slots before applying preference order.
export async function readCourtCatalog({ api, target, date, times = target.times ?? [],
  discoverTimes = false, signal, deadline = Infinity, tolerateUnavailable = false,
  partialOnDeadline = false, recordViews = false, timeoutMs, onQuery = () => {}, onRooms, onWait, onRateLimit = () => {}, onReleaseWait }) {
  const queries = new Set(times);
  const listedTimes = [];
  const issues = [];
  const recoverable = (error) => ['wait', 'retry', 'expired'].includes(error.outcome?.kind) || isTransientQueryError(error);
  const afterQuery = () => { signal?.throwIfAborted(); if (!partialOnDeadline) check(signal, deadline); };
  if (discoverTimes) {
    let rows = [];
    try {
      check(signal, deadline);
      rows = await api.getTimeList({ campusCode: target.campusCode, sportCode: target.sportCode,
        modeCode: target.modeCode, date, signal, deadline, onWait });
      afterQuery();
      if (!Array.isArray(rows)) throw new Error('时段接口响应格式异常：缺少时段数组');
      if (rows.some((row) => { try { splitTimeSlot(row?.CODE); return false; } catch { return true; } })) {
        throw new Error('时段接口响应格式异常：包含无效时段');
      }
    } catch (error) {
      signal?.throwIfAborted();
      const timedOut = partialOnDeadline && Date.now() >= deadline && error.code === 'REQUEST_NOT_SENT';
      if (!timedOut && (!tolerateUnavailable || !recoverable(error))) throw error;
      issues.push({ date, message: error.message, transient: isTransientQueryError(error), query: 'times' });
    }
    for (const row of rows) {
      try { splitTimeSlot(row?.CODE); } catch { continue; }
      listedTimes.push(row.CODE); queries.add(row.CODE);
    }
  }
  const found = new Map(), views = [];
  const slotRooms = new Map([...queries].map((time) => [time, new Map()]));
  const rank = (task) => {
    const index = target.courtNames?.findIndex((value) => value === task.room.WID || value === task.room.CDMC) ?? 0;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  queryLoop:
  for (const [venueIndex, venue] of target.venues.entries()) {
    for (const time of queries) {
      signal?.throwIfAborted();
      if (partialOnDeadline && Date.now() >= deadline) {
        issues.push({ date, time, message: '参考目录读取窗口结束，已保留读到的项目，可重新读取补充', query: 'deadline' });
        break queryLoop;
      }
      check(signal, deadline);
      const startedAt = Date.now();
      let rooms;
      try {
        rooms = await api.getOpeningRooms({ campusCode: target.campusCode, sportCode: target.sportCode,
          modeCode: target.modeCode, venueCode: venue.CGBM, date, time, signal, deadline, onWait,
          timeoutMs: timeoutMs === undefined ? undefined : Math.max(1, Math.min(timeoutMs, deadline - Date.now())) });
      } catch (error) {
        afterQuery();
        if (partialOnDeadline && Date.now() >= deadline && error.code === 'REQUEST_NOT_SENT') {
          issues.push({ date, time, venue: venue.CGBM, message: error.message, query: 'deadline' });
          break queryLoop;
        }
        const canContinue = recoverable(error);
        onQuery({ time, venue: venue.CGBM, durationMs: Date.now() - startedAt,
          outcome: canContinue ? 'unavailable' : 'error', message: error.message });
        if (!tolerateUnavailable || !canContinue) throw error;
        issues.push({ date, time, venue: venue.CGBM, message: error.message, transient: isTransientQueryError(error) });
        if (['rate', 'server'].includes(error.outcome?.scope) || error.status === 429) {
          onRateLimit(error); break queryLoop;
        }
        if (error.outcome?.scope === 'release' && onReleaseWait) {
          onReleaseWait(error); break queryLoop;
        }
        continue;
      }
      afterQuery();
      if (!Array.isArray(rooms)) throw new Error('场地接口响应格式异常：缺少场地数组');
      onQuery({ time, venue: venue.CGBM, durationMs: Date.now() - startedAt,
        outcome: rooms.length ? 'rooms' : 'empty', count: rooms.length,
        available: rooms.filter(room => !room.disabled).length, unavailable: rooms.filter(room => room.disabled).length });
      // Dated query evidence is for editor hints only; it never establishes
      // availability for another date or for a subsequent booking attempt.
      if (recordViews) {
        const matching = rooms.filter(room => room.CGBM === venue.CGBM);
        views.push({ date, time, venueCode: venue.CGBM, checkedAt: Date.now(),
          available: matching.filter(room => !room.disabled).map(room => room.WID),
          unavailable: matching.filter(room => room.disabled).map(room => room.WID) });
      }
      const group = { target, date, time, timeIndex: 0, venue, venueIndex };
      for (const task of roomsToTasks(group, rooms).sort(compareTasks)) {
        if (!found.has(task.room.WID)) found.set(task.room.WID, task);
        if (!slotRooms.get(time).has(task.room.WID)) slotRooms.get(time).set(task.room.WID, task);
      }
      if (onRooms && await onRooms({ time,
        rooms: [...slotRooms.get(time).values()].sort((a, b) => rank(a) - rank(b)).map((task) => task.room) }) === false) break queryLoop;
    }
  }
  const tasks = [...found.values()];
  tasks.sort((a, b) => rank(a) - rank(b));
  return { date, times: [...new Set(listedTimes)].sort(), rooms: tasks.map((t) => t.room), issues, views,
    roomsByTime: Object.fromEntries([...slotRooms].map(([time, rooms]) =>
      [time, [...rooms.values()].sort((a, b) => rank(a) - rank(b)).map((task) => task.room)])),
    courts: tasks.map((t) => ({ id: t.room.WID, name: t.room.CDMC, venue: t.venue.CGMC,
      venueCode: t.venue.CGBM, note: t.room.text || '' })) };
}

// Merge structure, including unavailable rows. This is never a live availability
// view: roomsByTime and cached rows must not be used by the booking loop.
export function mergeReferenceCatalogs(catalogs, { target, cached } = {}) {
  const freshRooms = new Map(), freshCourts = new Map();
  const times = new Set(catalogs.flatMap((catalog) => catalog.times));
  const freshTimes = new Set(times);
  for (const catalog of catalogs) {
    for (const room of catalog.rooms) if (!freshRooms.has(room.WID)) freshRooms.set(room.WID, room);
    for (const court of catalog.courts) if (!freshCourts.has(court.id)) freshCourts.set(court.id, court);
  }
  const cachedIds = new Set();
  for (const time of Array.isArray(cached?.times) ? cached.times : []) {
    try { splitTimeSlot(time); times.add(time); } catch { /* Ignore invalid old cache entries. */ }
  }
  for (const court of Array.isArray(cached?.courts) ? cached.courts : []) {
    if (!court || typeof court.id !== 'string' || !court.id || typeof court.name !== 'string') continue;
    if (!freshCourts.has(court.id)) { freshCourts.set(court.id, { ...court, cached: true }); cachedIds.add(court.id); }
  }
  for (const room of Array.isArray(cached?.rooms) ? cached.rooms : []) {
    if (room && typeof room.WID === 'string' && typeof room.CGBM === 'string' && typeof room.CDMC === 'string'
      && !freshRooms.has(room.WID)) freshRooms.set(room.WID, room);
  }
  const allowed = (room) => !target.courtNames || target.includeOtherCourts === true
    || target.courtNames.includes(room.WID) || target.courtNames.includes(room.CDMC);
  const rank = (room) => {
    const i = target.courtNames?.findIndex((value) => value === room.WID || value === room.CDMC) ?? 0;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const rooms = [...freshRooms.values()].filter(allowed).sort((a, b) => rank(a) - rank(b));
  const courts = [...freshCourts.values()].filter((court) => allowed({ WID: court.id, CDMC: court.name }))
    .sort((a, b) => rank({ WID: a.id, CDMC: a.name }) - rank({ WID: b.id, CDMC: b.name }));
  const sources = catalogs.filter((catalog) => catalog.rooms.length || catalog.times.length).map((catalog) => catalog.date);
  const primary = catalogs.find((catalog) => catalog.rooms.length) ?? catalogs.find((catalog) => catalog.times.length) ?? catalogs[0];
  const issues = catalogs.flatMap((catalog) => catalog.issues);
  const views = catalogs.flatMap(catalog => catalog.views ?? []);
  const history = new Map();
  for (const view of [...(Array.isArray(cached?.history) ? cached.history : []), ...catalogs.flatMap(catalog => catalog.history ?? []), ...views]) {
    if (!view || !/^\d{4}-\d{2}-\d{2}$/.test(view.date) || typeof view.venueCode !== 'string'
      || !Number.isFinite(view.checkedAt) || !Array.isArray(view.available) || !Array.isArray(view.unavailable)) continue;
    try { splitTimeSlot(view.time); } catch { continue; }
    const key = JSON.stringify([view.date, view.time, view.venueCode]);
    if (!history.has(key) || view.checkedAt >= history.get(key).checkedAt) history.set(key, view);
  }
  // Keep recent dated evidence bounded; the physical-court union is retained.
  const recentDates = new Set([...new Set([...history.values()].map(view => view.date))].sort().slice(-32));
  return { date: sources.length ? primary.date : cached?.date ?? primary?.date, dates: [...new Set(sources)],
    times: [...times].sort(), rooms, courts, issues, partial: issues.length > 0,
    views, history: [...history.values()].filter(view => recentDates.has(view.date)),
    cached: cachedIds.size > 0 || [...times].some((time) => !freshTimes.has(time)), reference: true };
}

// UI and check-only use the same multi-date reference. Authentication failures
// and malformed responses still surface; only known unavailable views continue.
export async function readReferenceCatalog({ dates, cached, ...options }) {
  const referenceDates = [...new Set(dates)];
  const configuredTimes = options.times ?? options.target.times ?? [];
  const knownTimes = new Set(configuredTimes);
  for (const time of Array.isArray(cached?.times) ? cached.times : []) {
    try { splitTimeSlot(time); knownTimes.add(time); } catch { /* Old cache is only a source of valid query candidates. */ }
  }
  // A date's time list is another time-dependent view. Discover all reference
  // dates first, then query every known slot on every date so a slot omitted
  // from one date cannot hide its physical courts.
  const discoveries = [];
  for (const date of referenceDates) {
    const discovery = await readCourtCatalog({ ...options, target: { ...options.target, venues: [] },
      date, times: [], discoverTimes: Boolean(options.api.getTimeList),
      tolerateUnavailable: true, partialOnDeadline: true,
      onQuery: (details) => options.onQuery?.({ ...details, date }) });
    discoveries.push(discovery);
    for (const time of discovery.times) knownTimes.add(time);
  }
  const catalogs = [];
  for (const [index, date] of referenceDates.entries()) {
    const catalog = await readCourtCatalog({ ...options, date, times: [...knownTimes].sort(), discoverTimes: false, recordViews: true,
      tolerateUnavailable: true, partialOnDeadline: true,
      onQuery: (details) => options.onQuery?.({ ...details, date }) });
    catalogs.push({ ...catalog, times: [...new Set([...discoveries[index].times, ...configuredTimes])],
      issues: [...discoveries[index].issues, ...catalog.issues] });
  }
  return mergeReferenceCatalogs(catalogs, { target: options.target, cached });
}

export function referenceDates(date = shanghaiDate()) {
  const today = shanghaiDate();
  // Booking release controls mutations, not which date may supply reference
  // structure. A weekday package list can omit courts offered on the weekend.
  // Try the selected date first, even before release, then merge nearby dates.
  return [...new Set([date, today, addDays(today, 1)])];
}
