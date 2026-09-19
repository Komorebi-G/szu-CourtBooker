import { spawn } from 'node:child_process';
import { mkdir, copyFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { delimiter } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const portable = join(root, '../.build/mobile-tools');
const env = { ...process.env };
const jdk = (await readdir(portable).catch(() => [])).find((name) => name.startsWith('jdk-21'));
if (jdk && !env.JAVA_HOME) env.JAVA_HOME = join(portable, jdk);
if (!env.ANDROID_HOME) {
  const sdk = join(portable, 'android-sdk');
  await access(sdk); env.ANDROID_HOME = sdk;
}
if (env.JAVA_HOME) env.PATH = join(env.JAVA_HOME, 'bin') + delimiter + env.PATH;
// Java does not read HTTP(S)_PROXY itself; scope proxy settings to this build.
const proxy = env.HTTPS_PROXY || env.https_proxy;
if (proxy) {
  const url = new URL(proxy);
  if (url.protocol === 'http:' && !url.username) env.GRADLE_OPTS = (env.GRADLE_OPTS || '')
    + ` -Dhttps.proxyHost=${url.hostname} -Dhttps.proxyPort=${url.port || 80} -Dhttp.proxyHost=${url.hostname} -Dhttp.proxyPort=${url.port || 80}`;
}
const portableGradle = join(portable, 'gradle-8.14.3/bin/gradle');
const hasPortable = await access(portableGradle).then(() => true, () => false);
await new Promise((resolve, reject) => {
  const child = spawn(hasPortable ? portableGradle : process.platform === 'win32' ? 'gradlew.bat' : './gradlew', ['assembleDebug', '--no-daemon', '--console=plain'],
    { cwd: join(root, 'android'), env, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Android 构建失败：${code}`)));
});
await mkdir(join(root, '../dist'), { recursive: true });
await copyFile(join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'), join(root, '../dist/SZU-CourtBooker-Android.apk'));
console.log('已生成 dist/SZU-CourtBooker-Android.apk（开发签名测试版）');
