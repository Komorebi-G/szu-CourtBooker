import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicWrite } from '../desktop/src/atomic-file.js';

test('原子替换保存完整 JSON，失败后保留原文件并清理临时文件', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-atomic-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await atomicWrite(path, '{"old":true}', { durable: true });
  await atomicWrite(path, '{"new":true}', { durable: true });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { new: true });
  await assert.rejects(atomicWrite(join(dir, 'absent', 'state.json'), '{}'));
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('真实 Windows 文件共享锁：短暂占用可恢复，超时不能先删除旧文件', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-sharing-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'); await atomicWrite(path, 'original');
  async function lock(ms) {
    const script = `$f=[IO.File]::Open('${path.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('LOCKED'); Start-Sleep -Milliseconds ${ms}; $f.Dispose()`;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const ended = once(child, 'exit');
    await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.on('data', data => { if (String(data).includes('LOCKED')) resolve(); }); });
    return { ended };
  }
  const short = await lock(300), started = performance.now();
  await atomicWrite(path, 'updated', { durable: true });
  assert.ok(performance.now() - started >= 200); await short.ended;
  assert.equal(await readFile(path, 'utf8'), 'updated');
  const long = await lock(300);
  await assert.rejects(atomicWrite(path, 'must-not-publish', { retryMs: 30 }));
  assert.equal(await readFile(path, 'utf8'), 'updated');
  await long.ended;
  assert.deepEqual(await readdir(dir), ['state.json']);
  await atomicWrite(path, 'recovered'); assert.equal(await readFile(path, 'utf8'), 'recovered');
});
