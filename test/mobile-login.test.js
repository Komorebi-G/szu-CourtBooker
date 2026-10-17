import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSchoolLogin } from '../mobile/src/login.js';
import { MobileStore } from '../mobile/src/store.js';
import { verifyAccount } from '../mobile/src/school.js';
import { SessionExpiredError } from '../shared/errors.js';

const captured = { cookie: 'MOD_AUTH_CAS=fake; _WEU=fake', userAgent: 'Android WebView test' };
function fixture() {
  let saved;
  const store = new MobileStore({ async writeState({ value }) { saved = JSON.parse(value); } });
  store.state.accounts = [{ id: 'a', name: '原备注', userId: 'A', user: '同学甲', session: { old: true } }];
  return { store, saved: () => saved };
}
test('手机学校登录：验证通过后新增，使用捕获的UA并保留其他账号', async () => {
  const f = fixture();
  const account = await saveSchoolLogin(f.store, captured, { verify: async (session) => {
    assert.equal(session.userAgent, captured.userAgent); return { id: 'B', name: '同学乙' };
  } });
  assert.equal(account.name, '同学乙'); assert.equal(account.session.source, 'android-webview');
  assert.equal(f.saved().accounts.length, 2); assert.deepEqual(f.saved().accounts[0].session, { old: true });
});
test('手机重新登录：保持账号ID、备注和已有方案引用', async () => {
  const f = fixture(); f.store.state.plans = [{ accountId: 'a' }];
  await saveSchoolLogin(f.store, captured, { accountId: 'a', verify: async () => ({ id: 'A', name: '同学甲' }) });
  assert.equal(f.saved().accounts.length, 1); assert.equal(f.saved().accounts[0].id, 'a');
  assert.equal(f.saved().accounts[0].name, '原备注'); assert.equal(f.saved().plans[0].accountId, 'a');
});
test('检查登录后自动恢复同一个已绑定账号，无需再次确认身份', async () => {
  const f = fixture();
  const account = await saveSchoolLogin(f.store, captured, { accountId: 'a',
    verify: async () => ({ id: 'A', name: '同学甲' }),
    confirmIdentity: () => { assert.fail('已绑定账号不应增加一次确认操作'); } });
  assert.equal(account.id, 'a');
  assert.equal(f.saved().accounts[0].session.source, 'android-webview');
});
test('手机登录错号、重复新增或会话无效均不覆盖原账号', async () => {
  const f = fixture(); const before = structuredClone(f.store.state);
  await assert.rejects(saveSchoolLogin(f.store, captured, { accountId: 'a', verify: async () => ({ id: 'B', name: '同学乙' }) }), /不是原账号/);
  await assert.rejects(saveSchoolLogin(f.store, captured, { verify: async () => ({ id: 'A', name: '同学甲' }) }), /已存在/);
  await assert.rejects(saveSchoolLogin(f.store, captured, { verify: async () => { throw new Error('登录过期'); } }), /登录过期/);
  await assert.rejects(saveSchoolLogin(f.store, null), /完整/);
  assert.deepEqual(f.store.state, before); assert.equal(f.saved(), undefined);
});
test('手机登录写入失败回滚内存，原账号保持可用', async () => {
  const f = fixture(); const before = structuredClone(f.store.state);
  f.store.device.writeState = async () => { throw new Error('空间不足'); };
  await assert.rejects(saveSchoolLogin(f.store, captured, { accountId: 'a', verify: async () => ({ id: 'A', name: '同学甲' }) }), /空间不足/);
  assert.deepEqual(f.store.state, before);
});
test('重新登录写入失败时，排队目录保存不能提交尚未保存的新账号', async () => {
  const f = fixture(); let entered, rejectLogin, writes = 0, saved;
  const writing = new Promise((resolve) => entered = resolve);
  f.store.device.writeState = async ({ value }) => {
    if (++writes === 1) { entered(); await new Promise((_, reject) => rejectLogin = reject); }
    saved = JSON.parse(value);
  };
  const login = saveSchoolLogin(f.store, captured, { accountId: 'a', name: '新备注', verify: async () => ({ id: 'A', name: '同学甲' }) });
  const failed = assert.rejects(login, /空间不足/);
  await writing;
  f.store.state.catalogs['a:badminton'] = { times: ['19:00-20:00'], courts: [] };
  const catalogSave = f.store.save();
  rejectLogin(new Error('空间不足'));
  await failed; await catalogSave;
  assert.equal(f.store.state.accounts[0].name, '原备注');
  assert.equal(saved.accounts[0].name, '原备注');
  assert.deepEqual(saved.accounts[0].session, { old: true });
  assert.deepEqual(saved.catalogs['a:badminton'].times, ['19:00-20:00']);
});
test('手机登录实际验证链路仅请求身份和日期，保存响应刷新Cookie', async () => {
  const f = fixture(); const calls = [];
  const transport = async (url, options) => {
    calls.push(new URL(url).pathname);
    assert.equal(options.headers['user-agent'], captured.userAgent);
    return { ok: true, status: 200, headers: { get: () => null, getSetCookie: () => ['_WEU=refreshed; Path=/qljfwapp/'] },
      text: async () => calls.length === 1 ? 'USERID=\'B\';USER_INFO={"userName":"同学乙"};APP_TITLE=' : '[]' };
  };
  await saveSchoolLogin(f.store, captured, { transport });
  assert.deepEqual(calls.map((path) => path.split('/').pop()), ['index.do', 'getRqList.do']);
  assert.equal(f.saved().accounts[1].session.cookies.find((c) => c.name === '_WEU').value, 'refreshed');
});

function checkFixture({ dates = '[]', failSave = false } = {}) {
  const paths = [];
  const device = { async writeState() { if (failSave) throw new Error('空间不足'); }, async request({ url }) {
    const path = new URL(url).pathname; paths.push(path);
    return { status: 200, headers: {}, body: path.endsWith('/index.do')
      ? 'USERID=\'A\';USER_INFO={"userName":"同学甲"};APP_TITLE=' : dates };
  } };
  const store = new MobileStore(device);
  const account = { id: 'a', name: '原备注', userId: 'A', user: '原姓名', session: { cookies: [], userAgent: 'test' } };
  store.state.accounts = [account];
  return { device, store, account, paths };
}
test('检查登录须验证场馆接口；身份有效但日期接口拒绝登录时不报告成功', async () => {
  const f = checkFixture({ dates: '{"code":"1","msg":"请先登录"}' });
  await assert.rejects(verifyAccount(f.store, f.device, f.account), SessionExpiredError);
  assert.deepEqual(f.paths.map((path) => path.split('/').pop()), ['index.do', 'getRqList.do']);
  assert.equal(f.account.verifiedAt, undefined); assert.equal(f.account.user, '原姓名');
});
test('检查登录的保存失败不能留下虚假的验证时间，保存成功后才发布身份', async () => {
  const failed = checkFixture({ failSave: true });
  await assert.rejects(verifyAccount(failed.store, failed.device, failed.account), /空间不足/);
  assert.equal(failed.store.state.accounts[0], failed.account);
  assert.equal(failed.account.verifiedAt, undefined); assert.equal(failed.account.user, '原姓名');
  const good = checkFixture(); await verifyAccount(good.store, good.device, good.account);
  assert.ok(good.store.state.accounts[0].verifiedAt); assert.equal(good.store.state.accounts[0].user, '同学甲');
});
test('日期接口返回非数组不能当成有效登录保存', async () => {
  const f = checkFixture({ dates: '{"unexpected":true}' });
  await assert.rejects(verifyAccount(f.store, f.device, f.account), /日期接口响应格式异常/);
  assert.equal(f.account.verifiedAt, undefined);
});
