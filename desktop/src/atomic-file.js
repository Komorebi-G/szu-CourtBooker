import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sleep } from '../../shared/utils.js';

// Keep the previous file intact while Windows readers briefly deny replacement.
export async function atomicWrite(path, value, { durable = false, mode = 0o600, retryMs = 1000 } = {}) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', mode);
    try { await file.writeFile(value); if (durable) await file.sync(); }
    finally { await file.close(); }
    const until = Date.now() + retryMs;
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error.code) || Date.now() >= until) throw error;
        await sleep(Math.min(20 * 2 ** Math.min(attempt, 4), until - Date.now()));
      }
    }
    if (durable && process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
