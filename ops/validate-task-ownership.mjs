import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTaskOwnershipInputs, validateTaskQueue } from './task-ownership.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { roster, queue } = await readTaskOwnershipInputs({
  rosterPath: resolve(root, 'data', 'team-roster.json'),
  queuePath: resolve(root, 'ops', 'task-queue.json'),
});
const errors = validateTaskQueue({ roster, queue });
if (errors.length) {
  console.error(errors.map((error) => `FAIL: ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`task ownership contract tests: PASS (${queue.tasks.length} tasks, ${roster.members.length} members)`);
}

