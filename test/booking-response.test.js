import test from 'node:test';
import assert from 'node:assert/strict';
import { SzuVenueApi } from '../shared/api.js';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { BASE_URL } from '../shared/constants.js';

for (const body of ['{}', 'null', '[]', '"ok"', '{"code":0}', '{"code":""}', '{"code":"  "}', '<html>error</html>']) {
  test(`预约响应不能确认结果时抛错：${body}`, async () => {
    let request;
    const client = new CoreHttpClient({ userAgent: 'test', cookies: [] }, { transport: async (url, options) => {
      request = { url: String(url), options };
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
    } });
    const api = new SzuVenueApi(client); api.identity = { id: 'a', name: 'test' };
    const deadline = Date.now() + 1000;
    await assert.rejects(api.book({ date: '2026-09-21', time: '15:00-16:00',
      room: { WID: 'A', CGBM: 'v', XMDM: '001', XQDM: '1' }, modeCode: '1.0', deadline }));
    assert.equal(request.url, BASE_URL + 'sportVenue/insertVenueBookingInfo.do');
    assert.equal(request.options.deadlineMs, deadline);
  });
}
test('过期的提交在传输之前拒绝', async () => {
  let calls = 0;
  const client = new CoreHttpClient({ userAgent: 'test', cookies: [] }, { transport: async () => { calls++; } });
  await assert.rejects(client.post('sportVenue/insertVenueBookingInfo.do', {}, { deadlineMs: Date.now() - 1 }), { code: 'REQUEST_NOT_SENT' });
  assert.equal(calls, 0);
});
