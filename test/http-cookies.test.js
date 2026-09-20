import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { BASE_URL } from '../shared/constants.js';

const response = (...cookies) => ({ headers: { getSetCookie: () => cookies } });

test('响应 Cookie 的 Max-Age 到期后不再发送，且优先于 Expires', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T00:00:00Z') });
  const client = new CoreHttpClient({ cookies: [] });
  client.updateCookies(response('_WEU=short; Max-Age=60; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Path=/'));
  assert.equal(client.cookieHeader(BASE_URL), '_WEU=short');
  t.mock.timers.tick(60_000);
  assert.equal(client.cookieHeader(BASE_URL), '');
});

test('服务端删除 Cookie 和导入零过期时间都不能继续携带凭据', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T00:00:00Z') });
  for (const maxAge of [0, -1]) {
    const client = new CoreHttpClient({ cookies: [] });
    client.updateCookies(response('_WEU=old; Path=/'));
    client.updateCookies(response(`_WEU=deleted; Path=/; Max-Age=${maxAge}`));
    assert.equal(client.cookieHeader(BASE_URL), '');
  }
  const client = new CoreHttpClient({ cookies: [{ name: '_WEU', value: 'old', domain: 'ehall.szu.edu.cn', path: '/', expires: 0 }] });
  assert.equal(client.cookieHeader(BASE_URL), '');
});

test('学校续发 Cookie 后使用并保存新的有效期', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T00:00:00Z') });
  let saved;
  const client = new CoreHttpClient({ cookies: [] }, { save: async (value) => { saved = value; } });
  client.updateCookies(response('_WEU=old; Max-Age=10; Path=/'));
  t.mock.timers.tick(5000);
  client.updateCookies(response('_WEU=new; Max-Age=60; Path=/'));
  await client.flush();
  t.mock.timers.tick(5000);
  const restored = new CoreHttpClient(saved);
  assert.equal(restored.cookieHeader(BASE_URL), '_WEU=new');
  t.mock.timers.tick(55_000);
  assert.equal(restored.cookieHeader(BASE_URL), '');
});

test('非法过期属性被忽略，不意外删除会话 Cookie', () => {
  const client = new CoreHttpClient({ cookies: [] });
  client.updateCookies(response('_WEU=session; Expires=invalid; Max-Age=invalid; Path=/'));
  assert.equal(client.cookieHeader(BASE_URL), '_WEU=session');
});
