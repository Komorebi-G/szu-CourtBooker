import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, 'www'), { recursive: true });
const hash = createHash('sha256');
for (const relative of ['src', '../shared', '../desktop/web']) {
  for (const name of (await readdir(join(root, relative))).sort()) {
    if (!/\.(js|css|html)$/.test(name)) continue;
    hash.update(relative + '/' + name + '\0').update(await readFile(join(root, relative, name)));
  }
}
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const buildId = hash.update(version).digest('hex').slice(0, 16);
await build({ entryPoints: [join(root, 'src/app.js')], outfile: join(root, 'www/app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['chrome109', 'safari16.4'], minify: true,
  define: { __COURT_BUILD_ID__: JSON.stringify(buildId), __COURT_VERSION__: JSON.stringify(version) } });
for (const file of ['index.html', 'styles.css', 'unsupported-webview.html']) await copyFile(join(root, 'src', file), join(root, 'www', file));
await copyFile(join(root, '../desktop/web/styles.css'), join(root, 'www/base.css'));
console.log('手机版静态资源已构建；未打包 Cookie、桌面配置或任务。');
