import { SessionExpiredError } from './errors.js';

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

  async getIdentity({ refresh = false } = {}) {
    if (this.identity && !refresh) return this.identity;
    const { data: html } = await this.client.get('index.do', { expect: 'text' });
    const id = /\bUSERID='([^']+)'/.exec(html)?.[1];
    const infoText = /\bUSER_INFO=(\{.*?\});APP_TITLE=/.exec(html)?.[1];
    let info;
    try {
      info = JSON.parse(infoText);
    } catch {
      throw new SessionExpiredError('无法确认登录身份，请重新登录后手动启动本次执行');
    }
    if (!id || !info?.userName) throw new Error('预约首页没有有效的用户身份');
    if (this.identity && this.identity.id !== id) throw new SessionExpiredError('登录身份已改变，请重新登录原账号后启动');
    this.identity = { id, name: info.userName };
    return this.identity;
  }

  async getSportVenueData() {
    return (await this.client.post('sportVenue/getSportVenueData.do')).data;
  }

  async getAvailableDates() {
    return (await this.client.post('sportVenue/getRqList.do')).data;
  }

  async getTimeList({ campusCode, date, modeCode, sportCode }) {
    return (await this.client.post('sportVenue/getTimeList.do', {
      XQ: campusCode,
      YYRQ: date,
      YYLX: modeCode,
      XMDM: sportCode,
    })).data;
  }

  async getOpeningRooms({ campusCode, date, modeCode, sportCode, venueCode, time }) {
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
    const response = (await this.client.post('modules/sportVenue/getOpeningRoom.do', form)).data;
    if (response.code !== '0') throw new Error(response.msg || '场地查询失败');
    return response.datas?.getOpeningRoom?.rows ?? [];
  }

  async book({ date, modeCode, room, time, deadline, signal }) {
    const identity = await this.getIdentity();
    const [start, end] = time.split('-');
    const response = (await this.client.post('sportVenue/insertVenueBookingInfo.do', {
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
    }, { deadlineMs: deadline, signal })).data;
    // HTTP success and valid JSON do not prove the school accepted or rejected a booking.
    if (!response || Array.isArray(response) || typeof response.code !== 'string' || !response.code.trim()) {
      throw new Error('预约接口未返回明确业务结果，结果待确认，请核对学校“我的预约”');
    }
    return response;
  }

  async getBookings({ pageNumber = 1, pageSize = 20 } = {}) {
    const response = (await this.client.post('modules/myBooking/myBookingInfo.do', {
      pageNumber,
      pageSize,
    })).data;
    return response.datas?.myBookingInfo ?? { rows: [], totalSize: 0 };
  }

  async cancelBooking(wid) {
    return (await this.client.post('sportVenue/cancelSelectBookingInfo.do', { WID: wid })).data;
  }

  async sampleServerOffset() {
    const response = await this.client.post('sportVenue/getRqList.do');
    if (!response.date) return 0;
    const serverSeconds = Date.parse(response.date);
    const midpoint = (response.startedAt + response.endedAt) / 2;
    return serverSeconds + 500 - midpoint;
  }
}
