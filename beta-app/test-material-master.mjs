import assert from 'node:assert/strict';
import { materialMasterSnapshot, resolveMaterial, searchMaterials, validateMaterialMaster } from './material-master.mjs';

assert.equal(validateMaterialMaster(), true);
assert.equal(resolveMaterial('GABA').materialId, 'GABA');
assert.equal(resolveMaterial('가바').canonicalName, 'Gamma-Aminobutyric Acid');
assert.equal(resolveMaterial(' G A B A ').materialId, 'GABA', '공백이 섞인 동의어도 초보 구매자 편의를 위해 정규화합니다.');
assert.equal(resolveMaterial('GABAX'), null, '미등록 원료는 자동 확정하지 않아야 합니다.');
assert.equal(resolveMaterial('없는 원료'), null);
assert.equal(resolveMaterial('GABA').specStatus, 'PENDING_HUMAN_APPROVAL');
assert.equal(resolveMaterial('GABA').tradeProfile.physicalMaterialOnly, true);
assert.equal(resolveMaterial('GABA').tradeProfile.priceUnit, 'KRW_PER_KG');
assert.equal(resolveMaterial('GABA').tradeProfile.currency, 'KRW');
assert.equal(resolveMaterial('GABA').simulationSpec.intendedUse, '기능성 식품 원료 개발');
assert.equal(resolveMaterial('GABA').simulationSpec.deliveryCondition, '상온·밀봉 배송');
assert.equal(resolveMaterial('GABA').specQuestionFlow.length, 6);
assert.equal(resolveMaterial('GABA').regulatoryProfile.status, 'HUMAN_REVIEW_REQUIRED');
assert.ok(resolveMaterial('GABA').riskProfile.preTradeGates.includes('EVIDENCE_VALID'));
assert.equal(searchMaterials('가바')[0].materialId, 'GABA');
assert.equal(searchMaterials('가바')[0].matchType, 'EXACT');
assert.equal(searchMaterials('Gamma')[0].matchType, 'PREFIX');
assert.deepEqual(searchMaterials('미등록 원료'), []);
assert.equal(searchMaterials('가바')[0].requiredSpecFields.length, 6, '검색 결과도 확정 전 스펙 기준을 참조해야 합니다.');
assert.deepEqual(materialMasterSnapshot().records[0].provenance.sourceDocuments, []);

const extensibilityFixture = materialMasterSnapshot();
const secondMaterial = JSON.parse(JSON.stringify(extensibilityFixture.records[0]));
secondMaterial.materialId = 'BETA-TEST';
secondMaterial.canonicalName = 'Beta Test Material';
secondMaterial.aliases = ['BETA-TEST', '베타 테스트'];
secondMaterial.identifiers.catalogIdentity = 'BETA-TEST';
secondMaterial.simulationSpec.specId = 'BETA-TEST-SPEC-001';
extensibilityFixture.records = [secondMaterial, extensibilityFixture.records[0]];
assert.equal(validateMaterialMaster(extensibilityFixture), true, 'Material Master는 동일 계약을 만족하는 신규 원료를 수용해야 합니다.');
assert.equal(resolveMaterial('베타테스트', extensibilityFixture).materialId, 'BETA-TEST');
assert.equal(searchMaterials('베타 테스트', { source: extensibilityFixture })[0].materialId, 'BETA-TEST');
assert.deepEqual(searchMaterials('베타 테스트')[0], undefined, 'fixture 원료는 운영 카탈로그에 자동 등록되면 안 됩니다.');

console.log('material-master tests: PASS');

