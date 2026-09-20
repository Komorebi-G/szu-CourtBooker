// Compatibility smoke check: the old OS entry must retire work, never book.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDispatcher } from '../desktop/src/dispatcher.js';
import { writeJson, exists } from '../desktop/src/jobs.js';
const dir = await mkdtemp(join(tmpdir(), 'szu-legacy-probe-'));
const id = randomUUID(), jobDir = join(dir, 'jobs', id);
await mkdir(jobDir, { recursive: true });
await writeJson(join(jobDir, 'job.json'), { id, mode: 'schedule', releaseAt: Date.now(), config: { targets: [] } });
await writeJson(join(jobDir, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
let removed = 0;
await runDispatcher(dir, { scheduler: { async remove(value) { assert.equal(value, id); removed++; } } });
assert.equal(removed, 1); assert.equal(await exists(join(jobDir, 'stop')), true);
console.log('通过：旧定时入口停用任务；没有注册系统任务，没有访问学校。');
