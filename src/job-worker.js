import { resolve } from 'node:path';
import { executeJob } from '../desktop/src/job-worker.js';
executeJob(resolve(process.argv[2])).catch((error) => { console.error(error.message); process.exitCode = 1; });
