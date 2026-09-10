import { resolveMaterial } from './material-master.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

export class SpecCompilerError extends Error {
  constructor(message, code = 'SPEC_COMPILER_FAILED') {
    super(message);
    this.code = code;
  }
}

const requiredQuestions = (record) => (record?.specQuestionFlow || []).filter((question) => question.required !== false);

const normalizeAnswers = (record, answers = {}) => {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new SpecCompilerError('스펙 답변 형식이 올바르지 않습니다.', 'SPEC_ANSWERS_INVALID');
  const questions = requiredQuestions(record);
  const allowedFields = new Set(questions.map((question) => question.field));
  const unknownField = Object.keys(answers).find((field) => !allowedFields.has(field));
  if (unknownField) throw new SpecCompilerError(`등록되지 않은 스펙 항목입니다: ${unknownField}`, 'SPEC_FIELD_UNKNOWN');
  const normalized = {};
  for (const question of questions) {
    if (answers[question.field] === undefined || answers[question.field] === null || String(answers[question.field]).trim() === '') continue;
    const value = String(answers[question.field]).trim();
    if (!question.options.includes(value)) throw new SpecCompilerError(`${question.label} 선택값이 허용 목록에 없습니다.`, 'SPEC_OPTION_INVALID');
    normalized[question.field] = value;
  }
  return normalized;
};

export const compileSpecDraft = ({ query, answers = {} } = {}) => {
  const material = resolveMaterial(query);
  if (!material) return { status: 'MATERIAL_NOT_FOUND', query: String(query || ''), match: null, answers: {}, missingFields: [], nextQuestion: null, specId: null };
  const questions = requiredQuestions(material);
  const normalizedAnswers = normalizeAnswers(material, answers);
  const missingFields = questions.filter((question) => normalizedAnswers[question.field] === undefined).map((question) => question.field);
  const nextQuestion = questions.find((question) => missingFields.includes(question.field));
  const complete = missingFields.length === 0;
  const canonical = Object.fromEntries(questions.map((question) => [question.field, material.simulationSpec?.[question.field]]));
  const matchesApprovedSpec = complete && questions.every((question) => normalizedAnswers[question.field] === canonical[question.field]);
  return {
    status: !complete ? 'NEEDS_INPUT' : matchesApprovedSpec ? 'READY_FOR_MATCHING' : 'NO_VERIFIED_SPEC_FOR_SPEC',
    query: String(query || ''),
    match: { materialId: material.materialId, canonicalName: material.canonicalName, matchedAlias: material.matchedAlias },
    answers: clone(normalizedAnswers),
    missingFields,
    nextQuestion: nextQuestion ? { field: nextQuestion.field, label: nextQuestion.label, options: clone(nextQuestion.options), position: questions.findIndex((question) => question.field === nextQuestion.field) + 1, total: questions.length } : null,
    specId: matchesApprovedSpec ? material.simulationSpec.specId : null,
    confirmation: { userAnsweredFields: Object.keys(normalizedAnswers), aiGuessedFields: [], canonicalSpecComparison: complete ? (matchesApprovedSpec ? 'MATCH' : 'MISMATCH') : 'INCOMPLETE' },
  };
};

export const answerSpecDraft = ({ query, draft, field, value } = {}) => {
  const priorAnswers = draft?.answers && typeof draft.answers === 'object' ? draft.answers : {};
  return compileSpecDraft({ query: query || draft?.query, answers: { ...priorAnswers, [field]: value } });
};
