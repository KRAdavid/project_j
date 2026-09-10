import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = JSON.parse(await readFile(resolve(root, 'data/authorization-policy.json'), 'utf8'));
assert.equal(policy.scope, 'PHYSICAL_MATERIAL_ONLY');
for (const role of ['OWNER', 'ADMIN', 'BUYER', 'SUPPLIER', 'OPERATOR', 'AUDITOR', 'AI']) assert.ok(Array.isArray(policy.roles[role]), `역할 누락: ${role}`);
for (const action of ['approve_trade', 'approve_contract', 'approve_payment', 'refund', 'close_dispute']) {
  assert.ok(policy.humanApprovalRequired.includes(action));
  assert.ok(policy.aiDeniedActions.includes(action));
}
assert.ok(policy.auditRequiredActions.includes('accept_order'));
assert.ok(policy.auditRequiredActions.includes('quarantine_lot'));
assert.ok(policy.humanApprovalRequired.includes('decide_operational_approval'));
assert.ok(policy.aiDeniedActions.includes('decide_operational_approval'));
assert.ok(policy.auditRequiredActions.includes('decide_operational_approval'));
assert.ok(policy.roles.OPERATOR.includes('acknowledge_operational_alert'));
assert.ok(policy.aiDeniedActions.includes('acknowledge_operational_alert'));
assert.ok(policy.auditRequiredActions.includes('acknowledge_operational_alert'));
assert.ok(policy.roles.SUPPLIER.includes('request_supplier_verification'));
assert.ok(policy.auditRequiredActions.includes('request_supplier_verification'));
assert.ok(policy.roles.OPERATOR.includes('expire_order'));
console.log('authorization policy tests: PASS');

