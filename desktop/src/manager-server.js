import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function managerIdentity(root, paths, packagedBuild) {
  let build = packagedBuild;
  if (!build) {
    const hash = createHash('sha256');
    async function collect(dir) {
      const entries = await readdir(join(root, dir), { withFileTypes: true });
      for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const name = `${dir}/${item.name}`;
        if (item.isDirectory()) await collect(name);
        else if (item.isFile()) { hash.update(name); hash.update(await readFile(join(root, name))); }
      }
    }
    for (const dir of ['desktop/src', 'desktop/web', 'shared']) await collect(dir);
    build = hash.digest('hex');
  }
  const profile = createHash('sha256').update(JSON.stringify(paths.map((path) => {
    const absolute = resolve(path); return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  }))).digest('hex');
  return { app: 'szu-court-booker', protocol: 1, build, profile };
}

async function reusable(url, identity, timeoutMs) {
  try {
    const request = (path) => fetch(url + path, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    const health = await request('/api/health');
    if (!health.ok) return false;
    const remote = await health.json();
    if (!remote.ready || !Object.entries(identity).every(([key, value]) => remote[key] === value)) return false;
    // A process can outlive its extracted files. A working API alone is insufficient.
    for (const [path, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/styles.css', 'text/css']]) {
      const response = await request(path);
      const content = await response.text();
      if (!response.ok || !response.headers.get('content-type')?.includes(type) || !content.trim()) return false;
    }
    return true;
  } catch { return false; }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { server.off('error', failed); server.off('listening', started); };
    const failed = (error) => { cleanup(); reject(error); };
    const started = () => { cleanup(); resolve(); };
    server.once('error', failed); server.once('listening', started); server.listen(port, host);
  });
}

export async function startManagerServer(server, { port, host, identity, probeTimeoutMs = 800 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('管理端口必须为 0 至 65535 的整数');
  // A deterministic scan also lets repeated launches find a healthy fallback instance.
  let occupied = 0;
  for (let offset = 0; offset <= 512; offset++) {
    const candidate = port === 0 || occupied >= 16 || offset === 512 || port + offset > 65535 ? 0 : port + offset;
    try {
      await listen(server, candidate, host);
      return { url: `http://127.0.0.1:${server.address().port}`, reused: false };
    } catch (error) {
      if (candidate === 0 || !['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
      // Windows excluded/reserved port ranges can deny otherwise unused adjacent ports.
      if (error.code === 'EADDRINUSE') occupied++;
      const url = `http://127.0.0.1:${candidate}`;
      if (await reusable(url, identity, probeTimeoutMs)) return { url, reused: true };
    }
  }
  throw new Error('无法分配管理端口');
}
