import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const loginUrl = 'https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/index.do#/sportVenue';
const localUrl = process.argv[2];
if (localUrl) {
  const parsed = new URL(localUrl);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('管理页面地址只能是本机 HTTP 地址');
  }
}
const url = localUrl || loginUrl;
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const edgeScript = join(codexHome, 'skills', 'wsl-windows-edge', 'scripts', 'edge.mjs');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`浏览器启动程序退出，状态码 ${code ?? 'unknown'}`));
    });
  });
}

async function launchExecutable(executable, profile, port = 9334) {
  await mkdir(profile, { recursive: true });
  console.log(`使用浏览器：${basename(executable)}`);
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function firstExisting(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function launchOnWindows() {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('缺少 LOCALAPPDATA，无法创建浏览器专用配置');
  const preference = (process.env.SZU_BROWSER || '').toLowerCase();
  const programFiles = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
  const candidates = {
    chrome: [
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...programFiles.map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ],
    edge: [
      join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...programFiles.map((root) => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ],
    brave: [
      join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ...programFiles.map((root) => join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
    ],
    chromium: [join(local, 'Chromium', 'Application', 'chrome.exe')],
  };
  const order = preference && candidates[preference]
    ? [preference, ...Object.keys(candidates).filter((name) => name !== preference)]
    : ['edge', 'chrome', 'brave', 'chromium'];
  const custom = process.env.SZU_BROWSER_PATH;
  const executable = custom && await exists(custom)
    ? custom
    : await firstExisting(order.flatMap((name) => candidates[name]));
  if (!executable) throw new Error('找不到 Chrome、Edge、Brave 或 Chromium');
  await launchExecutable(executable, join(local, 'SZUCourtBooker', 'browser-profile-edge'), 9335);
}

async function launchOnMac() {
  const preference = (process.env.SZU_BROWSER || '').toLowerCase();
  const candidates = {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
  };
  const order = preference && candidates[preference]
    ? [preference, ...Object.keys(candidates).filter((name) => name !== preference)]
    : ['edge', 'chrome', 'brave', 'chromium'];
  const custom = process.env.SZU_BROWSER_PATH;
  const executable = custom && await exists(custom)
    ? custom
    : await firstExisting(order.map((name) => candidates[name]));
  if (!executable) throw new Error('找不到 Chrome、Edge、Brave 或 Chromium');
  await launchExecutable(executable, join(homedir(), 'Library', 'Application Support', 'SZUCourtBooker'));
}

async function launchOnLinux() {
  const custom = process.env.SZU_BROWSER_PATH;
  let executable = custom && await exists(custom) ? custom : null;
  if (!executable) {
    const names = ['microsoft-edge', 'google-chrome', 'brave-browser', 'chromium', 'chromium-browser'];
    for (const name of names) {
      const result = spawnSync('which', [name], { encoding: 'utf8' });
      if (result.status === 0) {
        executable = result.stdout.trim();
        break;
      }
    }
  }
  if (!executable) throw new Error('找不到 Chrome、Edge、Brave 或 Chromium');
  await launchExecutable(executable, join(homedir(), '.local', 'share', 'szu-court-booker', 'browser-profile'));
}

async function launchWindowsBrowserFromWsl() {
  const preferred = (process.env.SZU_BROWSER || '').replaceAll("'", "''");
  const custom = (process.env.SZU_BROWSER_PATH || '').replaceAll("'", "''");
  const script = [
    `$preferred = '${preferred}'`,
    `$custom = '${custom}'`,
    "$roots = @($env:LOCALAPPDATA, $env:ProgramFiles, [Environment]::GetFolderPath('ProgramFilesX86'))",
    "$map = @{ chrome = 'Google\\Chrome\\Application\\chrome.exe'; edge = 'Microsoft\\Edge\\Application\\msedge.exe'; brave = 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'; chromium = 'Chromium\\Application\\chrome.exe' }",
    "$order = @('edge','chrome','brave','chromium')",
    "if ($preferred -and $map.ContainsKey($preferred)) { $order = @($preferred) + @($order | Where-Object { $_ -ne $preferred }) }",
    '$browser = $null',
    "if ($custom -and (Test-Path $custom)) { $browser = $custom }",
    "foreach ($name in $order) { foreach ($root in $roots) { if (-not $browser -and $root) { $candidate = Join-Path $root $map[$name]; if (Test-Path $candidate) { $browser = $candidate } } } }",
    "if (-not $browser) { throw 'Chrome, Edge, Brave or Chromium not found' }",
    "$profile = Join-Path $env:LOCALAPPDATA 'SZUCourtBooker\\browser-profile'",
    'New-Item -ItemType Directory -Force -Path $profile | Out-Null',
    `$arguments = @('--remote-debugging-port=9334', '--user-data-dir=' + $profile, '--no-first-run', '--no-default-browser-check', '${url}')`,
    'Write-Output $browser',
    'Start-Process -FilePath $browser -ArgumentList $arguments',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (!(await exists(powershell))) throw new Error('找不到 Windows PowerShell，无法启动 Windows 浏览器');
  await waitForChild(spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { stdio: 'inherit' }));
}

const isWsl = process.platform === 'linux'
  && /microsoft/i.test(await readFile('/proc/version', 'utf8').catch(() => ''));

if (isWsl && await exists(edgeScript) && !process.env.SZU_BROWSER && !process.env.SZU_BROWSER_PATH) {
  // 本机 WSL 环境遵循 Windows Edge 专用链路；其他平台走通用浏览器探测。
  const temporary = await mkdtemp(join(tmpdir(), 'szu-booker-browser-'));
  const environment = { ...process.env, WSL_EDGE_SESSION: 'szu-court-booker-auth' };
  try {
    await waitForChild(spawn(process.execPath, [edgeScript, 'open', url], {
      stdio: 'inherit', cwd: temporary, env: environment,
    }));
    await waitForChild(spawn(process.execPath, [edgeScript, 'detach'], {
      stdio: 'ignore', cwd: temporary, env: environment,
    }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else if (isWsl) {
  await launchWindowsBrowserFromWsl();
} else if (process.platform === 'win32') {
  await launchOnWindows();
} else if (process.platform === 'darwin') {
  await launchOnMac();
} else if (process.platform === 'linux') {
  await launchOnLinux();
} else {
  throw new Error(`暂不支持自动启动 ${process.platform} 浏览器，请使用通用 cURL 导入方式`);
}
