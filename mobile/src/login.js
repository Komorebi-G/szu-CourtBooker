import { CoreHttpClient } from '../../shared/http-client-core.js';
import { SzuVenueApi } from '../../shared/api.js';
import { parseSessionText } from '../../shared/session-format.js';

// Stage a captured session and verify it before touching the saved account.
// The login WebView never receives saved credentials or the app state file.
export async function saveSchoolLogin(store, captured, { accountId, name = '', transport, verify, confirmIdentity } = {}) {
  const previous = accountId ? store.state.accounts.find((a) => a.id === accountId) : null;
  if (accountId && !previous) throw new Error('原账号已不存在，请新增用户');
  if (!captured || typeof captured.cookie !== 'string' || typeof captured.userAgent !== 'string' || !captured.userAgent.trim()) {
    throw new Error('没有收到完整的学校登录信息，请重试');
  }
  let session = parseSessionText(captured.cookie);
  session = parseSessionText(JSON.stringify({ ...session, userAgent: captured.userAgent }));
  session.source = 'android-webview';
  let identity;
  if (verify) identity = await verify(session);
  else {
    const client = new CoreHttpClient(session, { transport, save: async (updated) => { session = updated; } });
    const api = new SzuVenueApi(client);
    identity = await api.getIdentity();
    await api.getAvailableDates(); // Read-only check of the actual booking session.
    await client.flush();
  }
  if (!identity?.id || !identity?.name) throw new Error('未能确认学校身份，登录未保存');
  if (previous?.userId && identity.id !== previous.userId) {
    throw new Error(`登录的是 ${identity.name}，不是原账号 ${previous.user || previous.name}。原登录未改动，请重新登录或新增用户。`);
  }
  if (store.state.accounts.some((a) => a.id !== previous?.id && a.userId === identity.id)) {
    throw new Error(`学校账号 ${identity.name} 已存在，请在对应账号上点击“重新登录”更新。`);
  }
  if (!previous?.userId && confirmIdentity && !await confirmIdentity(identity)) throw new Error('未确认学校身份，原登录未改动；请在学校窗口换号后重试');
  const account = { ...previous, id: previous?.id ?? crypto.randomUUID(),
    name: name.trim() || previous?.name || identity.name, userId: identity.id, user: identity.name,
    verifiedAt: new Date().toISOString(), session };
  if (account.name.length > 40) throw new Error('账号备注不能超过40个字符');
  const before = store.state.accounts;
  await store.update({ accounts: previous ? before.map((a) => a.id === account.id ? account : a) : [...before, account] });
  return account;
}
