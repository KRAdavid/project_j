import assert from 'node:assert/strict';
import { answerSpecDraft, compileSpecDraft, SpecCompilerError } from './spec-compiler.mjs';

const initial = compileSpecDraft({ query: ' 가 바 ' });
assert.equal(initial.status, 'NEEDS_INPUT');
assert.equal(initial.match.materialId, 'GABA');
assert.equal(initial.nextQuestion.field, 'intendedUse');
assert.equal(initial.nextQuestion.position, 1);
assert.equal(initial.nextQuestion.total, 6);
assert.deepEqual(initial.confirmation.aiGuessedFields, []);

const partial = answerSpecDraft({ query: 'GABA', draft: initial, field: 'intendedUse', value: '기능성 식품 원료 개발' });
assert.equal(partial.answers.intendedUse, '기능성 식품 원료 개발');
assert.equal(partial.nextQuestion.field, 'purity');

const complete = compileSpecDraft({ query: 'GABA', answers: {
  intendedUse: '기능성 식품 원료 개발', purity: '99% 이상', form: '분말', origin: '한국산', pack: '20 kg', deliveryCondition: '상온·밀봉 배송',
} });
assert.equal(complete.status, 'READY_FOR_MATCHING');
assert.equal(complete.specId, 'GABA-SPEC-001');
assert.equal(complete.nextQuestion, null);
assert.deepEqual(complete.missingFields, []);

const unmatched = compileSpecDraft({ query: 'GABA', answers: { ...complete.answers, purity: '98% 이상' } });
assert.equal(unmatched.status, 'NO_VERIFIED_SPEC_FOR_SPEC');
assert.equal(unmatched.specId, null);
assert.equal(unmatched.confirmation.canonicalSpecComparison, 'MISMATCH');

assert.throws(() => compileSpecDraft({ query: 'GABA', answers: { purity: '임의값' } }), (error) => error instanceof SpecCompilerError && error.code === 'SPEC_OPTION_INVALID');
assert.equal(compileSpecDraft({ query: '미등록 원료' }).status, 'MATERIAL_NOT_FOUND');
console.log('spec compiler tests: PASS');
