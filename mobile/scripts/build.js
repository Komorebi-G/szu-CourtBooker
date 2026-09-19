import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, 'www'), { recursive: true });
await build({ entryPoints: [join(root, 'src/app.js')], outfile: join(root, 'www/app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['chrome109', 'safari16.4'], minify: true });
for (const file of ['index.html', 'styles.css']) await copyFile(join(root, 'src', file), join(root, 'www', file));
await copyFile(join(root, '../desktop/web/styles.css'), join(root, 'www/base.css'));
console.log('手机版静态资源已构建；未打包 Cookie、桌面配置或任务。');
