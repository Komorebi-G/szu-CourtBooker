// Explicit release allowlist: never archive the workspace or private user data.
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const root = resolve('.'), output = join(root, 'dist/release');
await mkdir(output, { recursive: true });
const assets = ['SZU-CourtBooker-Windows-x64.exe', 'SZU-CourtBooker-Android-debug.apk', 'LICENSES.zip'];
await copyFile('dist/SZU-CourtBooker.exe', join(output, assets[0]));
await copyFile('dist/SZU-CourtBooker-Android.apk', join(output, assets[1]));
const staging = await mkdtemp(join(tmpdir(), 'szu-release-licenses-'));
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(file, join(staging, file));
async function collect(dir, destination) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const source = join(dir, entry.name), target = join(destination, entry.name);
    if (entry.isDirectory()) await collect(source, target);
    else if (/^(license|licence|notice|copying)(\.|$)/i.test(entry.name) || /\.LICENSE$/.test(entry.name)) {
      await mkdir(destination, { recursive: true }); await copyFile(source, target);
    }
  }
}
await collect('node_modules', join(staging, 'desktop-js'));
await collect('mobile/node_modules', join(staging, 'android-js-and-build'));
// These are upstream license texts, not executable downloads.
const sources = {
  'Node-LICENSE.txt': `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
  'OkHttp-LICENSE.txt': 'https://raw.githubusercontent.com/square/okhttp/parent-4.12.0/LICENSE.txt',
  'Okio-LICENSE.txt': 'https://raw.githubusercontent.com/square/okio/parent-3.6.0/LICENSE.txt',
  'AndroidX-LICENSE.txt': 'https://raw.githubusercontent.com/androidx/androidx/androidx-main/LICENSE.txt',
  'Kotlin-LICENSE.txt': 'https://raw.githubusercontent.com/JetBrains/kotlin/v2.2.21/license/LICENSE.txt',
};
for (const [name, url] of Object.entries(sources)) {
  await exec('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '60', url, '-o', join(staging, name)]);
}
await writeFile(join(staging, 'UPSTREAM-SOURCES.json'), JSON.stringify(sources, null, 2));
// A new archive avoids accidentally retaining stale files from a previous release.
const archive = join(await mkdtemp(join(tmpdir(), 'szu-release-archive-')), 'LICENSES.zip');
await exec('zip', ['-q', '-r', archive, '.'], { cwd: staging });
await copyFile(archive, join(output, 'LICENSES.zip'));
const sums = [];
for (const name of assets) {
  const bytes = await readFile(join(output, name));
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  console.log(`${name}: ${bytes.length} bytes`);
}
await writeFile(join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log('发行附件已写入 dist/release/，未包含本地账号、配置、任务或日志。');
