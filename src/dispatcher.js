// Old scheduled tasks continue to use this path after the workspace split.
import { resolve } from 'node:path';
import { runDispatcher } from '../desktop/src/dispatcher.js';
runDispatcher(resolve(process.argv[2])).catch((error) => { console.error(error.message); process.exitCode = 1; });
