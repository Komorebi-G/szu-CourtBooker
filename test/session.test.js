import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importSessionFromCurl, loadSession, saveSession } from '../desktop/src/session.js';

async function withSessionPath(run) {
  const directory = await mkdtemp(join(tmpdir(), 'court-booker-session-'));
  const path = join(directory, '.session.json');
  try {
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('从 Chromium 风格 cURL 导入 Cookie', async () => withSessionPath(async (path) => {
  await importSessionFromCurl(`curl 'https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/modules/sportVenue/getOpeningRoom.do' \\
    -H 'cookie: MOD_AUTH_CAS=auth-value; _WEU=weu-value; route=route-value' \\
    -H 'user-agent: Mozilla/5.0 Chromium Test'`, path);
  const session = await loadSession(path);
  assert.equal(session.userAgent, 'Mozilla/5.0 Chromium Test');
  assert.deepEqual(session.cookies.map((cookie) => cookie.name), ['MOD_AUTH_CAS', '_WEU', 'route']);
  assert.equal(session.cookies.find((cookie) => cookie.name === '_WEU').path, '/qljfwapp/');
}));

test('从 Firefox 风格 --cookie 导入 Cookie', async () => withSessionPath(async (path) => {
  await importSessionFromCurl(`curl 'https://ehall.szu.edu.cn/' \\
    --cookie 'MOD_AUTH_CAS=auth-value; _WEU=weu-value' \\
    --user-agent 'Mozilla/5.0 Firefox Test'`, path);
  const session = await loadSession(path);
  assert.equal(session.userAgent, 'Mozilla/5.0 Firefox Test');
  assert.equal(session.cookies.length, 2);
}));

test('并发刷新登录态时仍原子写入有效文件', async () => {
  await withSessionPath(async (path) => {
    const base = { version: 1, userAgent: 'test', cookies: [] };
    await Promise.all([
      saveSession({ ...base, savedAt: 'first' }, path),
      saveSession({ ...base, savedAt: 'second' }, path),
      saveSession({ ...base, savedAt: 'third' }, path),
    ]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).savedAt, 'third');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});
