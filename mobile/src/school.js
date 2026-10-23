import { CoreHttpClient } from '../../shared/http-client-core.js';
import { SzuVenueApi } from '../../shared/api.js';
import { resolveTargets } from '../../shared/planner.js';
import { getProject } from '../../shared/projects.js';
import { shanghaiDate } from '../../shared/utils.js';
import { readReferenceCatalog, mergeReferenceCatalogs, referenceDates } from '../../shared/catalog.js';
import { nativeTransport } from './device.js';

export function createConnection(store, device, account, token = null, options = {}) {
  const transport = nativeTransport(device, token, account.id, options);
  // The first identity read also belongs to this account's existing cooldown.
  // This binding schedules requests; getIdentity still verifies the login.
  if (account.userId) transport.bindIdentity(account.userId);
  const client = new CoreHttpClient(account.session, { transport,
    save: async () => { account.session = client.session; await store.save(); } });
  return { client, api: new SzuVenueApi(client) };
}
export async function verifyAccount(store, device, account) {
  const { api, client } = createConnection(store, device, account);
  let identity;
  try {
    identity = await api.getIdentity();
    if (account.userId && identity.id !== account.userId) throw new Error('登录身份改变，请恢复原账号，或新增一个用户');
    if (store.state.accounts.some((a) => a.id !== account.id && a.userId === identity.id)) throw new Error('此学校账号已绑定其他用户，请使用原用户');
    await api.getAvailableDates();
  } finally { await client.flush(); }
  const verified = { ...account, userId: identity.id, user: identity.name, verifiedAt: new Date().toISOString() };
  await store.update({ accounts: store.state.accounts.map((saved) => saved.id === account.id ? verified : saved) });
  return identity;
}
export async function readCatalog(store, device, account, projectId, targetDate = shanghaiDate(), { signal } = {}) {
  const { api, client } = createConnection(store, device, account);
  try {
    const identity = await api.getIdentity({ signal });
    if (account.userId && identity.id !== account.userId) throw new Error('登录身份不匹配，请更新登录');
    const project = getProject(projectId);
    const target = resolveTargets({ targets: [{ ...project, project: projectId, name: project.label,
      enabled: true, times: ['19:00-20:00'], courts: ['*'] }] }, await api.getSportVenueData({ signal }))[0];
    const reference = await readReferenceCatalog({ api, target, dates: referenceDates(targetDate), times: [],
      cached: store.state.catalogs[account.id + ':' + projectId], deadline: Date.now() + 45_000, signal });
    if (!reference.courts.length) throw new Error('参考日期暂未读到场地目录，可稍后刷新；正式执行会按目标日期重试');
    const key = account.id + ':' + projectId;
    // A refresh may finish after another refresh has saved new structure.
    const merged = mergeReferenceCatalogs([reference], { target, cached: store.state.catalogs[key] });
    const catalog = { date: reference.date, dates: reference.dates, times: merged.times, courts: merged.courts,
      views: merged.views, history: merged.history, issues: reference.issues,
      cached: reference.cached || merged.cached, partial: reference.partial,
      rooms: merged.rooms.map((room) => Object.fromEntries(['WID', 'CDMC', 'CGBM', 'CQBM', 'XMDM', 'XQDM']
        .filter((field) => room[field] !== undefined).map((field) => [field, room[field]]))) };
    signal?.throwIfAborted();
    const { views, ...saved } = catalog;
    await store.update({ catalogs: { ...store.state.catalogs, [key]: saved } });
    return catalog;
  } finally { await client.flush(); }
}
