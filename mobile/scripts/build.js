import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, 'www'), { recursive: true });
const hash = createHash('sha256');
async function hashTree(relative) {
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = relative + '/' + entry.name;
    if (entry.isDirectory()) await hashTree(path);
    else hash.update(path + '\0').update(await readFile(join(root, path)));
  }
}
for (const relative of ['src', '../shared', '../desktop/web']) {
  for (const name of (await readdir(join(root, relative))).sort()) {
    if (!/\.(js|css|html|svg)$/.test(name)) continue;
    hash.update(relative + '/' + name + '\0').update(await readFile(join(root, relative, name)));
  }
}
for (const relative of ['android/app/src/main/java', 'android/app/src/main/res']) await hashTree(relative);
const gradle = await readFile(join(root, 'android/app/build.gradle'), 'utf8');
hash.update(gradle).update(await readFile(join(root, 'android/app/src/main/AndroidManifest.xml')));
const version = /versionName\s+"([^"]+)"/.exec(gradle)?.[1];
if (!version) throw new Error('无法读取 Android 版本号');
const buildId = hash.update(version).digest('hex').slice(0, 16);
await writeFile(join(root, 'www/build.json'), JSON.stringify({ version, buildId }) + '\n');
await build({ entryPoints: [join(root, 'src/app.js')], outfile: join(root, 'www/app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['chrome109', 'safari16.4'], minify: true,
  define: { __COURT_BUILD_ID__: JSON.stringify(buildId), __COURT_VERSION__: JSON.stringify(version) } });
for (const file of ['index.html', 'styles.css', 'unsupported-webview.html']) await copyFile(join(root, 'src', file), join(root, 'www', file));
for (const file of ['styles.css', 'icon.svg']) await copyFile(join(root, '../desktop/web', file), join(root, 'www', file === 'styles.css' ? 'base.css' : file));
console.log('手机版静态资源已构建；未打包 Cookie、桌面配置或任务。');
