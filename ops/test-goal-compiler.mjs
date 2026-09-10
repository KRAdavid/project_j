import assert from 'node:assert/strict';
import { compileGoal } from './goal-compiler.mjs';

const result = await compileGoal({ intent: 'GABA 원료 거래 사이트의 검증 가능한 베타 목표를 실행하라.' });
assert.equal(result.compiler.domainPack, 'RAW_MATERIAL_OS_GABA_BETA');
assert.equal(result.contract.domainPackVersions.RAW_MATERIAL_OS_GABA_BETA, '0.1.0');
assert.equal(result.executionGuard.externalWriteAllowed, false);
assert.equal(result.firstValidActions[0].mode, 'READ_ONLY');
console.log('goal compiler tests: PASS');

