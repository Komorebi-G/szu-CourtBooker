import { CoreHttpClient } from '../../shared/http-client-core.js';
import { SzuVenueApi } from '../../shared/api.js';
import { resolveTargets } from '../../shared/planner.js';
import { getProject } from '../../shared/projects.js';
import { shanghaiDate, splitTimeSlot } from '../../shared/utils.js';
import { nativeTransport } from './device.js';

export function createConnection(store, device, account, token = null) {
  const client = new CoreHttpClient(account.session, { transport: nativeTransport(device, token),
    save: async () => { account.session = client.session; await store.save(); } });
  return { client, api: new SzuVenueApi(client) };
}
export async function verifyAccount(store, device, account) {
  const { api, client } = createConnection(store, device, account);
  try {
    const identity = await api.getIdentity();
    if (account.userId && identity.id !== account.userId) throw new Error('登录身份改变，请恢复原账号，或新增一个用户');
    account.userId = identity.id; account.user = identity.name; account.verifiedAt = new Date().toISOString();
    await store.save(); return identity;
  } finally { await client.flush(); }
}
export async function readCatalog(store, device, account, projectId) {
  const { api, client } = createConnection(store, device, account);
  try {
    const identity = await api.getIdentity();
    if (account.userId && identity.id !== account.userId) throw new Error('登录身份不匹配，请更新登录');
    const project = getProject(projectId);
    const target = resolveTargets({ targets: [{ ...project, project: projectId, name: project.label,
      enabled: true, times: ['19:00-20:00'], courts: ['*'] }] }, await api.getSportVenueData())[0];
    const date = shanghaiDate();
    const rows = await api.getTimeList({ campusCode: target.campusCode, sportCode: target.sportCode, modeCode: target.modeCode, date });
    const times = rows.map((row) => row.CODE).filter((value) => { try { splitTimeSlot(value); return true; } catch { return false; } });
    const courts = [];
    for (const venue of target.venues) {
      const rooms = await api.getOpeningRooms({ campusCode: target.campusCode, sportCode: target.sportCode,
        modeCode: target.modeCode, venueCode: venue.CGBM, date, time: times[0] ?? '19:00-20:00' });
      for (const room of rooms) if (!courts.some((c) => c.id === room.WID)) courts.push({ id: room.WID, name: room.CDMC });
    }
    if (!courts.length) throw new Error('没有读到场地目录，请检查登录或稍后重试');
    const catalog = { date, times, courts };
    store.state.catalogs[account.id + ':' + projectId] = catalog; await store.save();
    return catalog;
  } finally { await client.flush(); }
}
