import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Keep the beginning of the execution, while state.json retains the recent tail
// and lifetime counters. Long salvage runs cannot grow this file indefinitely.
export class DiagnosticJournal {
  constructor(dir, maxBytes = 8 * 1024 * 1024) {
    this.path = join(dir, 'events.ndjson'); this.maxBytes = maxBytes; this.bytes = 0;
  }
  async append(entry) {
    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line);
    if (this.bytes + bytes > this.maxBytes) return false;
    await appendFile(this.path, line, { mode: 0o600 });
    this.bytes += bytes; return true;
  }
}

export async function readDiagnosticJournal(dir) {
  const text = await readFile(join(dir, 'events.ndjson'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { /* A process kill may leave a partial last line. */ }
  }
  return events;
}
