// This bootstrap is embedded into node.exe. Application modules and dependencies
// are compressed assets, extracted into a versioned per-user cache on first launch.
const { getAsset } = require('node:sea');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { mkdirSync, existsSync, writeFileSync, renameSync, appendFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');
const { pathToFileURL } = require('node:url');

const args = process.argv.slice(2);
const homeIndex = args.indexOf('--home');
const requestedHome = homeIndex >= 0 ? args.splice(homeIndex, 2)[1] : null;
const base = requestedHome || process.env.SZU_HOME || join(process.env.LOCALAPPDATA || homedir(), 'SZUCourtBooker');
mkdirSync(base, { recursive: true });
async function main() {
  const compressed = Buffer.from(getAsset('application.gz'));
  const hash = createHash('sha256').update(compressed).digest('hex').slice(0, 16);
  const appRoot = join(base, 'app', hash);
  if (!existsSync(join(appRoot, '.ready'))) {
    const staging = `${appRoot}.${process.pid}.tmp`;
    mkdirSync(staging, { recursive: true });
    const files = JSON.parse(gunzipSync(compressed).toString('utf8'));
    for (const [name, encoded] of Object.entries(files)) {
      if (name.includes('..') || name.startsWith('/')) throw new Error('Invalid asset path');
      const path = join(staging, ...name.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(encoded, 'base64'));
    }
    writeFileSync(join(staging, '.ready'), hash);
    try { renameSync(staging, appRoot); }
    catch (error) { if (!existsSync(join(appRoot, '.ready'))) throw error; }
  }
  process.env.SZU_PACKAGED = '1';
  process.env.SZU_HOME = base;
  process.env.SZU_DATA ||= join(base, 'data');
  process.env.SZU_CONFIG ||= join(base, 'config.yaml');
  process.env.SZU_SESSION ||= join(base, '.session.json');
  if (!existsSync(process.env.SZU_CONFIG)) writeFileSync(process.env.SZU_CONFIG, 'targets: []\n');
  if (args[0] === '--diagnostics') {
    writeFileSync(args[1], JSON.stringify({ packaged: true, node: process.version, appRoot, base, pid: process.pid }));
    return;
  }
  const entries = ['src/web-server.js', 'src/dispatcher.js', 'scripts/auth.js', 'scripts/open-login.js'];
  const first = (args[0] || '').replaceAll('\\', '/');
  const entry = entries.find((path) => first.endsWith('/' + path)) || 'src/web-server.js';
  if (first.endsWith('/' + entry)) args.shift();
  const entryPath = join(appRoot, ...entry.split('/'));
  process.argv = [process.execPath, entryPath, ...args];
  process.chdir(appRoot);
  await import(pathToFileURL(entryPath).href);
}
main().catch((error) => {
  appendFileSync(join(base, 'startup.log'), `${new Date().toISOString()} ${error.stack}\n`);
  process.exitCode = 1;
});
