import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreHttpClient } from '../shared/http-client-core.js';

const session = () => ({ cookies: [], userAgent: 'test' });
const json = () => new Response('{"code":"0"}', { headers: { 'content-type': 'application/json' } });

test('只读准备的传输超时限制到截止时间，不能占住放号后的连接', async () => {
  let timeout;
  const client = new CoreHttpClient(session(), { timeoutMs: 5000, transport: async (_url, options) => {
    timeout = options.timeoutMs; return json();
  } });
  await client.post('sportVenue/getRqList.do', {}, { abortInFlight: true, deadlineMs: Date.now() + 1000 });
  assert.ok(timeout > 0 && timeout <= 1000);
});

test('停止立即中断在途只读查询，预约请求仍保留学校返回的成功', async () => {
  for (const abortInFlight of [true, false]) {
    const controller = new AbortController();
    const client = new CoreHttpClient(session(), { transport: async (_url, options) => {
      controller.abort(new Error('停止'));
      if (options.signal.aborted) throw options.signal.reason;
      return json();
    } });
    const request = client.post(abortInFlight ? 'sportVenue/getRqList.do' : 'sportVenue/insertVenueBookingInfo.do', {},
      { signal: controller.signal, abortInFlight });
    if (abortInFlight) await assert.rejects(request, /停止/);
    else assert.equal((await request).data.code, '0');
  }
});

test('原生账号队列等待后重新核对停止状态，不能因查询预备而多发预约', async () => {
  const controller = new AbortController();
  const client = new CoreHttpClient(session(), { transport: async (_url, options) => {
    controller.abort(); options.beforeDispatch(); return json();
  } });
  await assert.rejects(client.post('sportVenue/insertVenueBookingInfo.do', {}, { signal: controller.signal }),
    { code: 'REQUEST_NOT_SENT' });
});
