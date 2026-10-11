import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CoreHttpClient } from '../shared/http-client-core.js';

test('旧 WebView 信号兼容同时约束响应体读取，不能只等到收到响应头', async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/plain',
    'set-cookie': '_WEU=refreshed; Path=/' }); response.flushHeaders(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const any = AbortSignal.any, timeout = AbortSignal.timeout;
  try {
    AbortSignal.any = undefined; AbortSignal.timeout = undefined;
    const client = new CoreHttpClient({ cookies: [], userAgent: 'test' }, {
      // Leave enough time for HTTP headers under concurrent build/test load;
      // the deliberately unfinished body must still hit the request timeout.
      timeoutMs: 1000, transport: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options),
    });
    await assert.rejects(client.get('index.do', { expect: 'text', abortInFlight: true }),
      (error) => error.name === 'TimeoutError' || error.name === 'AbortError');
    assert.equal(client.session.cookies.find((cookie) => cookie.name === '_WEU')?.value, 'refreshed');
    assert.equal(client.dirty, true, '已收到的响应 Cookie 必须保留供持久化，即使正文超时');
  } finally {
    AbortSignal.any = any; AbortSignal.timeout = timeout;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
