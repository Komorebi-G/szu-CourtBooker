import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const source = await readFile(new URL('../scripts/sea-main.cjs', import.meta.url), 'utf8');
const files = { 'package.json': '{"type":"module"}', 'desktop/web/index.html': '<html>correct page</html>', 'desktop/web/app.js': 'correct script' };
const compressed = gzipSync(JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, Buffer.from(content).toString('base64')]))));
const hash = createHash('sha256').update(compressed).digest('hex').slice(0, 16);
async function launch(base) {
  const processMock = { argv: ['fake.exe', 'fake.exe', '--home', base, '--diagnostics', join(base, 'diagnostics.json')], env: {}, pid: process.pid, version: process.version };
  await runInNewContext(source, { Buffer, process: processMock, require: (name) => name === 'node:sea' ? { getAsset: () => compressed } : require(name) });
  assert.notEqual(processMock.exitCode, 1, await readFile(join(base, 'startup.log'), 'utf8').catch(() => ''));
  return JSON.parse(await readFile(join(base, 'diagnostics.json'), 'utf8'));
}
test('已存在.ready但页面删除或内容损坏，重开EXE恢复正确资源并保留用户配置', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'court-cache-')); t.after(() => rm(base, { recursive: true, force: true }));
  const first = await launch(base);
  await writeFile(join(base, 'config.yaml'), 'targets: [] # user data');
  await rm(join(first.appRoot, 'desktop/web/index.html'));
  await writeFile(join(first.appRoot, 'desktop/web/app.js'), 'broken script');
  await launch(base);
  for (const [path, content] of Object.entries(files)) assert.equal(await readFile(join(first.appRoot, path), 'utf8'), content);
  assert.equal(await readFile(join(base, 'config.yaml'), 'utf8'), 'targets: [] # user data');
});
test('上次解压中断留下非空目录且没有.ready，后续启动能够修复', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'court-cache-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'app', hash); await mkdir(root, { recursive: true }); await writeFile(join(root, 'package.json'), 'partial');
  await launch(base);
  assert.equal(await readFile(join(root, '.ready'), 'utf8'), hash);
  assert.equal(await readFile(join(root, 'desktop/web/index.html'), 'utf8'), files['desktop/web/index.html']);
});
