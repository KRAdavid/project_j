import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = await readFile(resolve(root, 'ops', 'ops-daemon.mjs'), 'utf8');
const cycleSource = await readFile(resolve(root, 'ops', 'run-ops-cycle.mjs'), 'utf8');
const autopilotSource = await readFile(resolve(root, 'ops', 'run-autopilot.mjs'), 'utf8');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

const assertions = [
  ['daemon invokes the operations cycle', source.includes("run-ops-cycle.mjs")],
  ['daemon supports an isolated cycle script for timeout verification', source.includes('OPS_DAEMON_CYCLE_SCRIPT') && source.includes('OPS_DAEMON_CHILD_STDIO')],
  ['daemon supports one-shot verification', source.includes("process.argv.includes('--once')")],
  ['daemon supports graceful shutdown', source.includes("process.on('SIGTERM', stop)")],
  ['daemon cannot bypass the cycle lock', source.includes("env: { ...process.env, OPS_DAEMON_CYCLE")],
  ['daemon bounds each cycle duration', source.includes('OPS_DAEMON_CYCLE_TIMEOUT_MS') && source.includes("log('cycle_timeout'") && source.includes('terminateChildTree(activeChild)')],
  ['daemon terminates child process trees and resolves timeout on Windows', source.includes("taskkill.exe") && source.includes("terminateChildTree(activeChild, { force: true })") && source.includes("signal: 'SIGKILL'")],
  ['daemon publishes liveness status', source.includes('OPS_DAEMON_STATUS_PATH') && source.includes("status: 'CYCLE_RUNNING'") && source.includes('writeStatus')],
  ['daemon records the last cycle decision separately from process failure', source.includes('OPS_DAEMON_CYCLE_EVIDENCE_PATH') && source.includes('lastCycleDecision') && source.includes('readCycleOutcome')],
  ['daemon schedules the next safe cycle after review is required', source.includes("status: stopping ? 'STOPPING' : 'WAITING'") && source.includes('timer = setTimeout(loop, intervalMs)')],
  ['daemon does not convert a review-required cycle into an automatic shutdown', source.includes('finish({ ...result, ...outcome, timedOut })') && source.includes("if (runOnce || stopping || (maxCycles > 0 && cycleCount >= maxCycles))")],
  ['cycle overlap is a safe skip', cycleSource.includes("SKIPPED_ALREADY_RUNNING") && cycleSource.includes("process.exit(0)")],
  ['manual autopilot overlap is a safe skip', autopilotSource.includes("SKIPPED_ALREADY_RUNNING") && autopilotSource.includes("process.exit(0)")],
  ['operations cycle is exposed as a direct npm command', packageJson.scripts['ops:cycle'] === 'node ops/run-ops-cycle.mjs'],
  ['daemon is exposed as an npm command', packageJson.scripts['ops:daemon'] === 'node ops/ops-daemon.mjs'],
];

const failures = assertions.filter(([, passed]) => !passed);
if (failures.length) {
  console.error(failures.map(([name]) => `FAIL: ${name}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`ops-daemon contract tests: PASS (${assertions.length})`);
}

