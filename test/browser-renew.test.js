import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpClient } from '../desktop/src/http-client.js';
import { loadSession, parseSessionText, saveSession } from '../desktop/src/session.js';
import { SessionExpiredError } from '../shared/errors.js';

test('只读身份检查可自动恢复场馆会话，预约 POST 不自动重放', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-browser-renew-'));
  const path = join(dir, 'session.json');
  await saveSession(parseSessionText('MOD_AUTH_CAS=old; _WEU=old'), path);
  let renewals = 0; const calls = [];
  const client = await HttpClient.create({ sessionPath: path, expectedUserId: 'A',
    renewSession: async () => { renewals++; return {
      identity: { id: 'A', name: '用户A' }, session: parseSessionText('MOD_AUTH_CAS=new; _WEU=new'),
    }; },
    transport: async (url, options) => {
      calls.push({ path: url.pathname, cookie: options.headers.cookie });
      const expired = options.headers.cookie.includes('MOD_AUTH_CAS=old') || url.pathname.includes('insertVenueBookingInfo');
      return { status: expired ? 302 : 200, ok: !expired,
        headers: { get: () => 'text/html', getSetCookie: () => [] }, text: async () => 'identity page' };
    },
  });
  assert.equal((await client.get('index.do', { expect: 'text' })).data, 'identity page');
  assert.equal(renewals, 1); assert.equal(calls.length, 2);
  assert.match(calls[1].cookie, /MOD_AUTH_CAS=new/);
  assert.equal((await loadSession(path)).cookies[0].value, 'new');
  await assert.rejects(client.post('sportVenue/insertVenueBookingInfo.do', {}), SessionExpiredError);
  assert.equal(renewals, 1); assert.equal(calls.length, 3);
});
test('执行中自动恢复遇到另一个账号时不替换会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-browser-wrong-user-'));
  const path = join(dir, 'session.json');
  await saveSession(parseSessionText('MOD_AUTH_CAS=old; _WEU=old'), path);
  const client = await HttpClient.create({ sessionPath: path, expectedUserId: 'A',
    renewSession: async () => ({ identity: { id: 'B', name: '用户B' },
      session: parseSessionText('MOD_AUTH_CAS=B; _WEU=B') }),
    transport: async () => ({ status: 302, ok: false,
      headers: { get: () => null, getSetCookie: () => [] }, text: async () => '' }),
  });
  await assert.rejects(client.get('index.do', { expect: 'text' }), /另一个学校账号/);
  assert.equal((await loadSession(path)).cookies[0].value, 'old');
});
