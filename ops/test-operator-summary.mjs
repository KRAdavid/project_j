import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = 4190;
const server = spawn(process.execPath, ['beta-app/server.mjs'], {
  cwd: root,
  env: { ...process.env, APP_ENV: 'simulation', PERSISTENCE_MODE: 'memory', PORT: String(port), OPS_ROOT: resolve(root, 'ops') },
  stdio: 'ignore',
});

const requestJson = (path) => new Promise((resolveResponse, reject) => {
  const request = http.get(`http://127.0.0.1:${port}${path}`, { timeout: 3000 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      if (response.statusCode !== 200) return reject(new Error(`${path} HTTP ${response.statusCode}`));
      try { return resolveResponse(JSON.parse(body)); } catch (error) { return reject(error); }
    });
  });
  request.on('timeout', () => request.destroy(new Error(`${path} timeout`)));
  request.on('error', reject);
});

try {
  const deadline = Date.now() + 15000;
  let health = null;
  while (Date.now() < deadline) {
    try {
      health = await requestJson('/api/health');
      break;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  assert.equal(health?.service, 'raw-material-beta');
  assert.equal(health?.eventStream, 'SSE');
  const summary = await requestJson('/api/ops/summary?role=operator');
  assert.ok(summary.taskTimelineAudit, '업무 생명주기 감사 상태가 운영 요약에 없습니다.');
  assert.ok(summary.taskAuditRemediation, '감사 정정 계획 상태가 운영 요약에 없습니다.');
  assert.ok(summary.supervisorStatus, '운영 감독자 상태가 운영 요약에 없습니다.');
  assert.ok(['RUNNING', 'DEGRADED', 'HALTED_REQUIRES_H01', 'NOT_REPORTED'].includes(summary.supervisorStatus.status));
  assert.ok(['NO_ACTION', 'WAITING_FOR_H01_APPROVAL', 'READY_FOR_H01_APPROVAL', 'APPLIED', 'MANUAL_REVIEW_REQUIRED'].includes(summary.taskAuditRemediation.status));
  assert.match(summary.taskAuditRemediation.planId || '', /^TASK-AUDIT-REMEDIATION-[a-f0-9]{20}$/);
  const remediationApproval = (summary.approvalInbox?.items || []).find((item) => item.approvalId === 'APPROVAL-TRIGGER-AUTO-QUALITY_GATE_FAILED-task-audit:active-timeline');
  assert.ok(remediationApproval, '감사 정정 H-01 승인 항목이 운영 요약에 없습니다.');
  assert.ok(['PENDING', 'APPROVED', 'HELD', 'REJECTED', 'CHANGES_REQUESTED'].includes(remediationApproval.status));
  assert.ok(['OUTBOX_ONLY', 'DELIVERED', 'DELIVERY_FAILED', 'PARTIAL_FAILURE', 'BLOCKED'].includes(summary.notificationOutbox?.delivery));
  console.log('operator summary contract: PASS');
} finally {
  server.kill();
}

