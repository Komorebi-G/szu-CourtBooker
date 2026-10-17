import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function recordBuild(dist, { platform, filename, version, buildId }) {
  const record = { platform, filename, version, buildId, builtAt: new Date().toISOString(),
    sha256: sha256(await readFile(join(dist, filename))) };
  await writeFile(join(dist, `${platform}-build.json`), JSON.stringify(record, null, 2) + '\n');
  const sums = [];
  for (const name of ['windows', 'android']) {
    let saved;
    try { saved = JSON.parse(await readFile(join(dist, `${name}-build.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (sha256(await readFile(join(dist, saved.filename))) === saved.sha256) sums.push(`${saved.sha256}  ${saved.filename}`);
  }
  await writeFile(join(dist, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
}
