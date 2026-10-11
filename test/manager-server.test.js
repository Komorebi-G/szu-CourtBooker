import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startManagerServer } from '../desktop/src/manager-server.js';

const identity = { app: 'szu-court-booker', protocol: 1, build: 'current', profile: 'home-a' };
async function serve(t, { health = identity, broken = false, missingExperience = false, hang = false, legacy = false } = {}) {
  const server = createServer((req, res) => {
    if (hang) return;
    if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(legacy ? { ok: false } : { ...health, ready: true })); }
    else if (req.url === '/api/bootstrap') res.end(JSON.stringify({ app: 'szu-court-booker' }));
    else if (broken || (missingExperience && req.url === '/experience.js')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"页面不存在"}'); }
    else { res.setHeader('content-type', req.url === '/' ? 'text/html' : req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(req.url === '/' ? '<html>test</html>' : 'test'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server;
}
function fresh(t) {
  const server = createServer((req, res) => { res.end('new'); });
  t.after(() => { server.closeAllConnections(); server.close(); }); return server;
}
for (const [name, options] of [
  ['旧版API正常但页面不存在', { legacy: true, broken: true }],
  ['同版实例的页面缓存丢失', { broken: true }],
  ['主界面存在但交互模块缺失', { missingExperience: true }],
  ['不同构建版本', { health: { ...identity, build: 'old' } }],
  ['不同数据目录', { health: { ...identity, profile: 'home-b' } }],
  ['端口上的服务不响应', { hang: true }],
]) test(`${name}：不复用，自动选择可用端口`, async (t) => {
  const old = await serve(t, options), server = fresh(t);
  const result = await startManagerServer(server, { port: old.address().port, host: '127.0.0.1', identity, probeTimeoutMs: 100 });
  assert.equal(result.reused, false); assert.notEqual(server.address().port, old.address().port);
  assert.equal(await (await fetch(result.url)).text(), 'new');
  assert.equal(old.listening, true, '不终止旧服务或预约任务');
});
test('同构建、同数据且全部页面资源健康时才复用', async (t) => {
  const old = await serve(t), server = fresh(t);
  const result = await startManagerServer(server, { port: old.address().port, host: '127.0.0.1', identity });
  assert.equal(result.reused, true); assert.equal(server.listening, false);
  assert.equal(result.url, `http://127.0.0.1:${old.address().port}`);
});
test('端口0显式创建独立实例，非法端口明确报错', async (t) => {
  const server = fresh(t);
  await assert.rejects(startManagerServer(server, { port: NaN, host: '127.0.0.1', identity }), /管理端口/);
  assert.equal((await startManagerServer(server, { port: 0, host: '127.0.0.1', identity })).reused, false);
});
test('Windows相邻端口被系统保留时继续寻找可用端口', async (t) => {
  const server = fresh(t), original = server.listen; let attempts = 0;
  server.listen = function (port, host) {
    if (++attempts <= 20) {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('reserved'), { code: 'EACCES' })));
      return this;
    }
    return original.call(this, 0, host);
  };
  const result = await startManagerServer(server, { port: 4173, host: '127.0.0.1', identity });
  assert.equal(result.reused, false); assert.equal(attempts, 21);
  assert.equal(await (await fetch(result.url)).text(), 'new');
});
test('Windows独占端口报EACCES时仍能识别同版健康实例', async (t) => {
  const old = await serve(t), server = fresh(t);
  server.listen = function () { queueMicrotask(() => this.emit('error', Object.assign(new Error('exclusive'), { code: 'EACCES' }))); return this; };
  const result = await startManagerServer(server, { port: old.address().port, host: '127.0.0.1', identity });
  assert.equal(result.reused, true); assert.equal(server.listening, false);
});
