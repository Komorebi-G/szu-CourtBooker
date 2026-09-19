import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSchoolLogin } from '../mobile/src/login.js';
import { MobileStore } from '../mobile/src/store.js';

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
