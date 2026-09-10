import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReadinessDiagnostics } from './readiness-diagnostics.mjs';

const configPath = resolve(fileURLToPath(new URL('../ops/release-readiness.json', import.meta.url)));

export const loadReleaseReadiness = async () => JSON.parse(await readFile(configPath, 'utf8'));

export const evaluateReleaseReadiness = async ({ environment = process.env.APP_ENV || 'simulation', env = process.env } = {}) => {
  const config = await loadReleaseReadiness();
  const diagnostics = buildReadinessDiagnostics({ environment, env });
  const diagnosticCurrent = Object.fromEntries(diagnostics.map((item) => [item.id, item.status === 'READY']));
  const current = {
    'R-01': diagnosticCurrent['R-01'],
    'R-02': diagnosticCurrent['R-02'],
    'R-03': true,
    'R-04': diagnosticCurrent['R-04'],
    'R-05': diagnosticCurrent['R-05'],
    'R-06': diagnosticCurrent['R-06'],
    'R-07': diagnosticCurrent['R-07'],
    'R-08': true,
  };
  const checks = config.checks.map((check) => ({ ...check, current: check.required ? Boolean(current[check.id]) : true }));
  const required = checks.filter((check) => check.required);
  return {
    ...config,
    environment,
    decision: required.every((check) => check.current) ? 'GO' : 'NO_GO',
    checks,
    diagnostics,
    missing: required.filter((check) => !check.current).map((check) => check.id),
    evaluatedAt: new Date().toISOString(),
  };
};
