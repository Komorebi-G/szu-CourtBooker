import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../desktop/src/accounts.js';
import { loadSession, parseSessionText } from '../desktop/src/session.js';

test('多用户登录隔离，JSON导出导入无损，摘要不会暴露Cookie', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-account-test-'));
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'legacy.json'),
    verifyIdentity: async (session) => ({ id: session.cookies[0].value, name: session.cookies[0].value }) });
  const a = await accounts.create('我'), b = await accounts.create('舍友');
  await accounts.import(a.id, 'MOD_AUTH_CAS=user-a; _WEU=secret-a');
  await accounts.import(b.id, 'MOD_AUTH_CAS=user-b; _WEU=secret-b');
  assert.equal((await accounts.verify(a.id)).userId, 'user-a');
  assert.equal((await accounts.verify(b.id)).userId, 'user-b');
  const summaries = JSON.stringify(await accounts.list());
  assert.ok(!summaries.includes('secret-a') && !summaries.includes('secret-b') && !summaries.includes('cookies'));
  const exported = await accounts.export(b.id);
  const c = await accounts.create('导入副本');
  await accounts.import(c.id, JSON.stringify(exported));
  assert.deepEqual((await loadSession(accounts.sessionPath(c.id))).cookies, exported.session.cookies);
  await accounts.clear(a.id);
  assert.equal((await accounts.summary(a.id)).exists, false);
  assert.equal((await accounts.summary(b.id)).exists, true);
});

test('已绑定的账号拒绝被其他用户Cookie覆盖，并保留原登录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-account-binding-'));
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'legacy.json'),
    verifyIdentity: async (session) => ({ id: session.cookies[0].value, name: '测试' }) });
  const a = await accounts.create('用户A');
  await accounts.import(a.id, 'MOD_AUTH_CAS=A; _WEU=A'); await accounts.verify(a.id);
  const before = await readFile(accounts.sessionPath(a.id), 'utf8');
  await assert.rejects(accounts.import(a.id, 'MOD_AUTH_CAS=B; _WEU=B'), /不一致/);
  assert.equal(await readFile(accounts.sessionPath(a.id), 'utf8'), before);
});

test('不接受其他网站Cookie、非法header和路径穿越', async () => {
  const good = parseSessionText('MOD_AUTH_CAS=A; _WEU=B');
  assert.throws(() => parseSessionText(JSON.stringify({ ...good, userAgent: 'bad\r\nvalue' })), /格式无效/);
  assert.throws(() => parseSessionText(JSON.stringify({ ...good, cookies: [{ ...good.cookies[0], domain: 'other.example' }] })), /域名无效/);
  const accounts = new AccountStore({ dataDir: '/unused', legacySessionPath: '/unused' });
  assert.throws(() => accounts.sessionPath('../escape'), /编号无效/);
});
