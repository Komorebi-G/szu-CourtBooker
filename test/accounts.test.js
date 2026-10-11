import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../desktop/src/accounts.js';
import { loadSession, parseSessionText, saveSession } from '../desktop/src/session.js';
import { SessionExpiredError } from '../shared/errors.js';
import { exists } from '../desktop/src/jobs.js';

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
test('浏览器识别身份先暂存，检查不写入；确认才绑定，重复学校身份拒绝绑定', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-account-confirm-'));
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'legacy.json'),
    verifyIdentity: async (session) => ({ id: session.cookies[0].value, name: '测试用户' }) });
  const a = await accounts.create('我'), b = await accounts.create('舍友'), staging = join(dir, 'staging.json');
  await saveSession(parseSessionText('MOD_AUTH_CAS=A; _WEU=A'), staging);
  assert.equal((await accounts.inspectLogin(a.id, staging)).id, 'A');
  assert.equal(await exists(accounts.sessionPath(a.id)), false);
  await accounts.bindLogin(a.id, staging);
  await assert.rejects(accounts.bindLogin(b.id, staging), /已绑定/);
  assert.equal(await exists(accounts.sessionPath(b.id)), false);
  await accounts.import(b.id, 'MOD_AUTH_CAS=A; _WEU=A');
  await assert.rejects(accounts.verify(b.id), /已绑定/);
  await accounts.clear(b.id); assert.equal((await accounts.verify(a.id)).valid, true);
});
test('同时验证两个未绑定用户时不能抢先绑定同一学校身份两次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-account-race-'));
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'legacy.json'),
    verifyIdentity: async () => ({ id: 'same-school-user', name: '测试用户' }) });
  const a = await accounts.create('我'), b = await accounts.create('舍友');
  await accounts.import(a.id, 'MOD_AUTH_CAS=A; _WEU=A'); await accounts.import(b.id, 'MOD_AUTH_CAS=B; _WEU=B');
  const results = await Promise.allSettled([accounts.verify(a.id), accounts.verify(b.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /已绑定/);
});
test('暂存身份验证后取消绑定，提交守卫阻止写入账号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-account-bind-stop-'));
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'legacy.json'),
    verifyIdentity: async () => ({ id: 'A', name: '测试用户' }) });
  const account = await accounts.create('新用户'), staging = join(dir, 'staging.json');
  await saveSession(parseSessionText('MOD_AUTH_CAS=A; _WEU=A'), staging);
  await assert.rejects(accounts.bindLogin(account.id, staging, { check: () => { throw new Error('已取消'); } }), /已取消/);
  assert.equal(await exists(accounts.sessionPath(account.id)), false);
  assert.equal((await accounts.summary(account.id)).userId, null);
});

test('不接受其他网站Cookie、非法header和路径穿越', async () => {
  const good = parseSessionText('MOD_AUTH_CAS=A; _WEU=B');
  assert.throws(() => parseSessionText(JSON.stringify({ ...good, userAgent: 'bad\r\nvalue' })), /格式无效/);
  assert.throws(() => parseSessionText(JSON.stringify({ ...good, cookies: [{ ...good.cookies[0], domain: 'other.example' }] })), /域名无效/);
  const accounts = new AccountStore({ dataDir: '/unused', legacySessionPath: '/unused' });
  assert.throws(() => accounts.sessionPath('../escape'), /编号无效/);
});
test('历史验证成功不能当成当前有效；复验失败后清除旧成功标记', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-account-expiry-')); let expired = false;
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'session.json'),
    verifyIdentity: async () => { if (expired) throw new Error('登录失效'); return { id: 'A', name: '测试' }; } });
  await accounts.import('default', 'MOD_AUTH_CAS=A; _WEU=B');
  assert.equal((await accounts.verify()).valid, true);
  assert.equal((await accounts.summary()).valid, null);
  expired = true; await assert.rejects(accounts.verify(), /登录失效/);
  assert.equal((await accounts.summary()).verifiedAt, null);
});
test('场馆会话失效时可用统一认证恢复，身份不符则保留原登录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-account-sso-'));
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'session.json'),
    verifyIdentity: async (session) => {
      if (session.cookies[0].value === 'old') throw new SessionExpiredError('场馆会话失效');
      return { id: session.cookies[0].value, name: '测试' };
    },
    renewSession: async (_userId, port) => { assert.equal(port, 9337); return {
      session: parseSessionText('MOD_AUTH_CAS=B; _WEU=new'), identity: { id: 'B', name: '另一个账号' },
    }; },
  });
  await accounts.import('default', 'MOD_AUTH_CAS=old; _WEU=old');
  await saveSession({ ...await loadSession(accounts.sessionPath()), browserCdpPort: 9337 }, accounts.sessionPath());
  await accounts.setMetadata('default', { name: '原账号', userId: 'A' });
  const before = await readFile(accounts.sessionPath(), 'utf8');
  await assert.rejects(accounts.verify(), /另一个学校账号/);
  assert.equal(await readFile(accounts.sessionPath(), 'utf8'), before);
  accounts.renewSession = async () => ({ session: parseSessionText('MOD_AUTH_CAS=A; _WEU=new'), identity: { id: 'A', name: '原账号' } });
  assert.equal((await accounts.verify()).valid, true);
  assert.equal((await loadSession(accounts.sessionPath())).cookies[0].value, 'A');
});

test('单个账号备注缺失或损坏，不影响正常账号列表、验证和损坏记录清理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-account-corrupt-'));
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'session.json'),
    verifyIdentity: async () => ({ id: 'A', name: '用户A' }) });
  const normal = await accounts.create('正常账号'), broken = await accounts.create('坏账号');
  await accounts.import(normal.id, 'MOD_AUTH_CAS=A; _WEU=B');
  await rm(join(accounts.dir(broken.id), 'account.json'));
  const list = await accounts.list();
  assert.equal(list.find((item) => item.id === broken.id).corrupt, true);
  assert.equal((await accounts.verify(normal.id)).valid, true);
  await accounts.clear(broken.id);
  assert.equal((await accounts.summary(broken.id)).exists, false);
});

test('慢导入验证期间登录已清除时，不允许旧导入重新覆盖账号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-account-stale-'));
  let release, entered;
  const waiting = new Promise((resolve) => release = resolve), reading = new Promise((resolve) => entered = resolve);
  let hold = false;
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'session.json'),
    verifyIdentity: async () => { if (hold) { entered(); await waiting; } return { id: 'A', name: '用户A' }; } });
  await accounts.import('default', 'MOD_AUTH_CAS=A; _WEU=old'); await accounts.verify();
  hold = true;
  const importing = accounts.import('default', 'MOD_AUTH_CAS=A; _WEU=new'); await reading;
  await accounts.clear(); release();
  await assert.rejects(importing, /状态已变化/);
  assert.equal((await accounts.summary()).exists, false);
});
