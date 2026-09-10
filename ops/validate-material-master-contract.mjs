import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(await readFile(resolve(root, 'data/material-master-contract.json'), 'utf8'));
const catalog = JSON.parse(await readFile(resolve(root, 'data/material-master.json'), 'utf8'));

assert.equal(contract.scope, 'PHYSICAL_MATERIAL_ONLY');
assert.equal(contract.specificationContract.noAiGuessing, true);
assert.equal(contract.tradeContract.physicalMaterialOnly, true);
assert.equal(contract.riskContract.unknownStatePolicy, 'FAIL_CLOSED');
assert.ok(Array.isArray(catalog.records) && catalog.records.length > 0);

for (const record of catalog.records) {
  for (const field of contract.requiredRecordFields) assert.ok(Object.prototype.hasOwnProperty.call(record, field), `Material Master 필드 누락: ${record.materialId}.${field}`);
  assert.ok(contract.materialClasses.includes(record.materialClass), `허용되지 않은 원료 분류: ${record.materialClass}`);
  assert.deepEqual(record.tradeProfile.physicalMaterialOnly, true, `실물 원료 전용 플래그 누락: ${record.materialId}`);
  assert.deepEqual(record.requiredEvidence, ['COA', 'SDS', 'TDS', 'lotTrace', 'inventoryProof']);
  for (const field of record.requiredSpecFields) {
    assert.ok(Object.prototype.hasOwnProperty.call(record.simulationSpec, field), `스펙 값 누락: ${record.materialId}.${field}`);
    const question = record.specQuestionFlow.find((candidate) => candidate.field === field);
    assert.ok(question, `스펙 질문 누락: ${record.materialId}.${field}`);
    assert.equal(question.required, true, `필수 질문 플래그 누락: ${record.materialId}.${field}`);
    assert.ok(Array.isArray(question.options) && question.options.length > 0, `질문 선택지 누락: ${record.materialId}.${field}`);
  }
  for (const gate of contract.riskContract.requiredPreTradeGates) assert.ok(record.riskProfile.preTradeGates.includes(gate), `거래 전 게이트 누락: ${record.materialId}.${gate}`);
}
console.log('material master contract: PASS');

