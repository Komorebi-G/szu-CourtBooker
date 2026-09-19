import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SESSION_FILE } from '../shared/constants.js';
import { HttpClient } from '../desktop/src/http-client.js';
import { SzuVenueApi } from '../shared/api.js';
import { importSessionFromCdp, loadSession, saveSession } from '../desktop/src/session.js';
import { sleep } from '../shared/utils.js';

const sessionPath = process.env.SZU_SESSION || DEFAULT_SESSION_FILE;
await mkdir(dirname(sessionPath), { recursive: true });
const stagingPath = `${sessionPath}.login-${randomUUID()}`;

function runLoginLauncher() {
  return new Promise((resolve, reject) => {
    const launcher = fileURLToPath(new URL('./open-login.js', import.meta.url));
    const child = spawn(process.execPath, [launcher], {
      cwd: process.cwd(),
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`浏览器启动失败，状态码 ${code ?? 'unknown'}`));
    });
  });
}

async function verify() {
  const client = await HttpClient.create({ sessionPath: stagingPath });
  const api = new SzuVenueApi(client);
  const identity = await api.getIdentity();
  await api.getAvailableDates();
  await client.flush();
  return identity;
}

console.log('正在打开专用浏览器。请在窗口中完成深圳大学统一身份认证，不要关闭场馆预约页面。');
try {
  await runLoginLauncher();
} catch (error) {
  console.error(`自动启动浏览器失败：${error.message}`);
  console.error('你仍可使用任意浏览器登录，然后在账号管理中导入登录 JSON 或 cURL。');
  process.exit(1);
}

const deadline = Date.now() + 5 * 60_000;
let lastMessage = '';
while (Date.now() < deadline) {
  try {
    await importSessionFromCdp(stagingPath);
    const identity = await verify();
    if (process.env.SZU_EXPECTED_USER_ID && identity.id !== process.env.SZU_EXPECTED_USER_ID) {
      throw new Error(`浏览器当前为 ${identity.name}，请在学校页面切换到此任务用户`);
    }
    await saveSession(await loadSession(stagingPath), sessionPath);
    await rm(stagingPath, { force: true });
    console.log(`登录态已保存，当前用户：${identity.name}`);
    process.exit(0);
  } catch (error) {
    const message = error.message;
    if (message !== lastMessage) {
      console.log(`等待登录：${message}`);
      lastMessage = message;
    }
    await sleep(800);
  }
}

console.error('等待登录超时。请在账号管理中重新点击浏览器登录。');
await rm(stagingPath, { force: true });
process.exitCode = 1;
