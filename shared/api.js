import { SessionExpiredError, SchoolQueryError, RequestNotSentError } from './errors.js';
import { classifyBookingResponse } from './booking-outcome.js';
import { serverClockInterval } from './server-clock.js';
import { resolveDate, splitTimeSlot } from './utils.js';

// Preserve the receiver of stateful API methods (especially identity). Prototype
// wrappers split the cache between preflight and book(), allowing a second login.
export function withBooking(api, book) {
  return new Proxy(api, { get(target, property) {
    if (property === 'book') return book;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export class SzuVenueApi {
  constructor(client) {
    this.client = client;
    this.identity = null;
  }

  async getIdentity({ refresh = false, signal, deadline, timeoutMs } = {}) {
    if (this.identity && !refresh) return this.identity;
    const { data: html } = await this.client.get('index.do', { expect: 'text', signal, deadlineMs: deadline,
      timeoutMs, abortInFlight: true });
    const id = /\bUSERID='([^']+)'/.exec(html)?.[1];
    const infoText = /\bUSER_INFO=(\{.*?\});APP_TITLE=/.exec(html)?.[1];
    let info;
    try {
      info = JSON.parse(infoText);
    } catch {
      throw new SessionExpiredError('无法确认登录身份，请重新登录后手动启动本次执行');
    }
    if (!id || !info?.userName) throw new SessionExpiredError('预约首页没有有效的用户身份，请重新登录');
    if (this.identity && this.identity.id !== id) throw new SessionExpiredError('登录身份已改变，请重新登录原账号后启动');
    this.identity = { id, name: info.userName };
    return this.identity;
  }

  async getSportVenueData({ signal, deadline, timeoutMs } = {}) {
    return (await this.client.post('sportVenue/getSportVenueData.do', {}, {
      signal, deadlineMs: deadline, timeoutMs, abortInFlight: true,
    })).data;
  }

  async getAvailableDates({ signal, deadline, timeoutMs } = {}) {
    return (await this.client.post('sportVenue/getRqList.do', {}, {
      signal, deadlineMs: deadline, timeoutMs, abortInFlight: true,
    })).data;
  }

  async getTimeList({ campusCode, date, modeCode, sportCode, signal, deadline, timeoutMs }) {
    const rows = (await this.client.post('sportVenue/getTimeList.do', {
      XQ: campusCode,
      YYRQ: date,
      YYLX: modeCode,
      XMDM: sportCode,
    }, { signal, deadlineMs: deadline, timeoutMs, abortInFlight: true })).data;
    if (!Array.isArray(rows)) {
      if (typeof rows?.code === 'string' && rows.code !== '0') throw new SchoolQueryError(classifyBookingResponse(rows));
      throw new Error('时段接口响应格式异常：缺少时段数组');
    }
    return rows;
  }

  async getOpeningRooms({ campusCode, date, modeCode, sportCode, venueCode, time, signal, deadline, timeoutMs }) {
    const [start, end] = time.split('-');
    const form = {
      XMDM: sportCode,
      YYRQ: date,
      YYLX: modeCode,
      KSSJ: start,
      JSSJ: end,
      XQDM: campusCode,
    };
    if (venueCode) form.CGBM = venueCode;
    const response = (await this.client.post('modules/sportVenue/getOpeningRoom.do', form, {
      signal, deadlineMs: deadline, timeoutMs, abortInFlight: true,
    })).data;
    if (!response || typeof response !== 'object') throw new Error('场地接口响应格式异常');
    if (response.code !== '0') {
      throw new SchoolQueryError(classifyBookingResponse(response));
    }
    const rows = response.datas?.getOpeningRoom?.rows;
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.WID !== 'string' || !row.WID.trim()
      || typeof row.CGBM !== 'string' || !row.CGBM.trim() || typeof row.CDMC !== 'string' || !row.CDMC.trim())) {
      throw new Error('场地接口响应格式异常：缺少有效的场地数组');
    }
    return rows.map((row) => {
      const code = (value) => typeof value === 'string' ? value
        : Number.isSafeInteger(value) ? String(value) : undefined;
      const XMDM = code(row.XMDM ?? sportCode), XQDM = code(row.XQDM ?? campusCode);
      if (typeof XMDM !== 'string' || !XMDM.trim() || typeof XQDM !== 'string' || !XQDM.trim()
        || (sportCode !== undefined && XMDM !== sportCode) || (campusCode !== undefined && XQDM !== campusCode)) {
        throw new Error('场地接口响应格式异常：项目或校区与查询不一致');
      }
      return { ...row, XMDM, XQDM };
    });
  }

  async book({ date, modeCode, room, time, deadline, signal, requestId, requestMetadata, onDispatch, beforeDispatch }) {
    if (!room || ['WID', 'CGBM', 'XMDM', 'XQDM'].some((field) => typeof room[field] !== 'string' || !room[field].trim())) {
      throw new RequestNotSentError('预约场地缺少有效的场地、场馆、项目或校区信息，未发送请求');
    }
    let identity, start, end;
    try {
      resolveDate(date);
      ({ start, end } = splitTimeSlot(time));
      if (!['1.0', '2.0'].includes(modeCode)) throw new Error('预约类型无效');
      identity = await this.getIdentity({ signal, deadline });
    } catch (error) {
      throw new RequestNotSentError(`预约前校验失败，未发送请求：${error.message}`, { cause: error });
    }
    let request, persistenceError;
    try {
      request = await this.client.post('sportVenue/insertVenueBookingInfo.do', {
        DHID: '',
        YYRGH: identity.id,
        YYRXM: identity.name,
        CYRS: modeCode === '2.0' ? '1' : '',
        CQBM: room.CQBM ?? '',
        CGDM: room.CGBM,
        CDWID: room.WID,
        XMDM: room.XMDM,
        XQWID: room.XQDM,
        KYYSJD: time,
        YYRQ: date,
        YYLX: modeCode,
        YYKS: `${date} ${start}`,
        YYJS: `${date} ${end}`,
        PC_OR_PHONE: 'pc',
      }, { deadlineMs: deadline, signal, requestId, requestMetadata, onDispatch, beforeDispatch });
    } catch (error) {
      if (!error.requestResult) throw error;
      request = error.requestResult;
      persistenceError = error.message;
    }
    const response = request.data;
    // HTTP success and valid JSON do not prove the school accepted or rejected a booking.
    if (!response || Array.isArray(response) || typeof response.code !== 'string' || !response.code.trim()) {
      throw new Error('预约接口未返回明确业务结果，结果待确认，请核对学校“我的预约”');
    }
    return { ...response, ...(persistenceError ? { persistenceError } : {}), requestTiming: { httpStatus: request.status,
      startedAt: request.startedAt, durationMs: Date.now() - request.startedAt } };
  }

  async getBookings({ pageNumber = 1, pageSize = 20, signal, deadline, timeoutMs } = {}) {
    const response = (await this.client.post('modules/myBooking/myBookingInfo.do', {
      pageNumber,
      pageSize,
    }, { signal, deadlineMs: deadline, timeoutMs, abortInFlight: true })).data;
    const data = response?.datas?.myBookingInfo;
    if ((response?.code !== undefined && response.code !== '0') || !Array.isArray(data?.rows)
      || !(typeof data?.totalSize === 'number' || (typeof data?.totalSize === 'string' && /^\d+$/.test(data.totalSize)))
      || !Number.isSafeInteger(Number(data.totalSize)) || Number(data.totalSize) < data.rows.length
      || data.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('我的预约接口未返回可核对的记录，不能据此认定没有预约');
    }
    return { rows: data.rows, totalSize: Number(data.totalSize) };
  }

  async getAllBookings({ signal, deadline, timeoutMs } = {}) {
    const rows = [];
    const pageSignatures = new Set();
    const rowSignatures = new Set();
    let total;
    for (let page = 1; page <= 50; page++) {
      const data = await this.getBookings({ pageNumber: page, pageSize: 100, signal, deadline, timeoutMs });
      if (total !== undefined && total !== data.totalSize) throw new Error('预约记录在翻页期间发生变化，请重新核对');
      total = data.totalSize;
      const signature = JSON.stringify(data.rows);
      if (data.rows.length && pageSignatures.has(signature)) throw new Error('学校重复返回同一页预约记录，不能确认记录完整');
      pageSignatures.add(signature);
      for (const row of data.rows) {
        const rowSignature = JSON.stringify(Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]])));
        if (rowSignatures.has(rowSignature)) throw new Error('学校重复返回预约记录，不能确认分页记录完整');
        rowSignatures.add(rowSignature);
      }
      if (!data.rows.length && rows.length < total) throw new Error('预约记录分页不完整，请在学校系统核对');
      rows.push(...data.rows);
      if (rows.length > total) throw new Error('预约记录数量不一致，请重新核对');
      if (rows.length === total) return rows;
    }
    throw new Error('预约记录过多，请在学校系统核对');
  }

  async cancelBooking(wid) {
    return (await this.client.post('sportVenue/cancelSelectBookingInfo.do', { WID: wid })).data;
  }

  async sampleServerClock({ signal, deadline, timeoutMs = 1000 } = {}) {
    signal?.throwIfAborted();
    const remaining = Number.isFinite(deadline) ? deadline - Date.now() : timeoutMs;
    if (remaining <= 0) throw new DOMException('校时截止时间已到', 'TimeoutError');
    const response = await this.client.post('sportVenue/getRqList.do', {}, {
      signal, deadlineMs: deadline, timeoutMs: Math.min(timeoutMs, remaining), abortInFlight: true,
    });
    signal?.throwIfAborted();
    return { serverDateMs: response.date ? Date.parse(response.date) : NaN,
      startedAt: response.startedAt, endedAt: response.endedAt, age: response.age };
  }

  async sampleServerOffset(options) {
    const interval = serverClockInterval(await this.sampleServerClock(options));
    if (!interval.valid) throw new Error(`学校服务器时钟采样失败：${interval.reason}`);
    return (interval.lowerOffsetMs + interval.upperOffsetMs) / 2;
  }
}
