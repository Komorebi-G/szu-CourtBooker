import { readFile, writeFile, readdir, mkdir, copyFile, stat, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import postject from 'postject';

const exec = promisify(execFile);
const root = resolve('.'), build = join(root, '.build'), dist = join(root, 'dist');
await mkdir(build, { recursive: true }); await mkdir(dist, { recursive: true });
const nodeExe = process.env.SZU_WINDOWS_NODE || (process.platform === 'win32' ? process.execPath : '/mnt/c/Program Files/nodejs/node.exe');
const version = (await exec(nodeExe, ['--version'])).stdout.trim();
if (version !== process.version) throw new Error(`生成 SEA 的 Node 必须与 Windows Node 同版：${process.version} != ${version}`);
const files = {};
async function collect(relative) {
  for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${item.name}`;
    if (item.isDirectory()) await collect(name);
    else if (item.isFile()) files[name] = (await readFile(join(root, name))).toString('base64');
  }
}
// Explicit allowlist: never bundle config.yaml, real cookies, accounts, jobs, or logs.
for (const dir of ['src', 'desktop/src', 'desktop/web', 'shared', 'node_modules/yaml', 'node_modules/playwright-core']) await collect(dir);
for (const name of ['scripts/auth.js', 'scripts/open-login.js']) files[name] = (await readFile(join(root, name))).toString('base64');
files['package.json'] = Buffer.from(JSON.stringify({ type: 'module' })).toString('base64');
await writeFile(join(build, 'application.gz'), gzipSync(JSON.stringify(files), { level: 9 }));
await writeFile(join(build, 'sea.json'), JSON.stringify({ main: join(root, 'scripts/sea-main.cjs'),
  output: join(build, 'sea.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
  assets: { 'application.gz': join(build, 'application.gz') } }));
await exec(process.execPath, ['--experimental-sea-config', join(build, 'sea.json')]);
const output = join(dist, 'SZU-CourtBooker.exe');
await chmod(output, 0o755).catch((error) => { if (error.code !== 'ENOENT') throw error; });
await copyFile(nodeExe, output);
await chmod(output, 0o755);
// Remove the original certificate directory before changing signed bytes.
let pe = await readFile(output);
const header = pe.readUInt32LE(0x3c), optional = header + 24;
if (pe.toString('ascii', header, header + 4) !== 'PE\0\0' || pe.readUInt16LE(optional) !== 0x20b) throw new Error('只支持 Windows x64 PE32+');
pe.fill(0, optional + 112 + 4 * 8, optional + 112 + 5 * 8);
await writeFile(output, pe);
await postject.inject(output, 'NODE_SEA_BLOB', await readFile(join(build, 'sea.blob')),
  { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
pe = await readFile(output);
// IMAGE_SUBSYSTEM_WINDOWS_GUI: the assistant has no console window.
pe.writeUInt16LE(2, pe.readUInt32LE(0x3c) + 24 + 68);
pe.writeUInt32LE(0, pe.readUInt32LE(0x3c) + 24 + 64);
await writeFile(output, pe);
const hash = createHash('sha256').update(pe).digest('hex');
await writeFile(join(dist, 'SHA256SUMS.txt'), `${hash}  SZU-CourtBooker.exe\n`);
await writeFile(join(dist, '使用说明.txt'), `深圳大学场馆预约助手\r\n\r\n双击 SZU-CourtBooker.exe，无需安装 Node.js、npm 或 Python。\r\n程序没有黑色终端，界面通过本机浏览器打开。关闭网页标签不会停止本次执行。\r\n账号、任务和日志保存在 %LOCALAPPDATA%\\SZUCourtBooker。\r\n在账号管理中添加用户，导入舍友的登录 JSON/cURL，任务选择对应用户。\r\n登录 JSON 包含账号登录权限，仅分享给可信的人。\r\n提前保存方案，放号当天重新登录或验证，再点击“开始本次执行”。Cookie 可能过期。\r\n停止单次预约请点击“停止本次执行”；“退出并停止执行”会停止全部预约。\r\n新版不注册系统定时，不自动补跑。执行期间保持助手运行、电脑醒着且联网。\r\n首次打开会停用当前数据目录的旧定时项；更新前请先停止旧版本的执行。尚未进行代码签名。\r\n本次打包不包含任何用户 Cookie、历史任务或日志。\r\n版本运行时：${version} · Windows x64\r\n`);
console.log(`已生成 ${output} (${((await stat(output)).size / 1048576).toFixed(1)} MiB)`);
console.log(`SHA256 ${hash}`);
