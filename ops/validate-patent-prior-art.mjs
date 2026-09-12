import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = JSON.parse(await readFile(resolve(root, 'data', 'patent-prior-art.json'), 'utf8'));
if (source.schemaVersion !== 'PATENT-PRIOR-ART-0.1' || !source.researchDate || !/공개 특허|등록성|법률/.test(source.sourcePolicy)) throw new Error('특허 선행기술 원장 메타데이터가 불완전합니다.');
if (!Array.isArray(source.documents) || source.documents.length < 2) throw new Error('공식 선행기술 문헌이 부족합니다.');
for (const document of source.documents) {
  if (!/^PA-\d{3}$/.test(document.id) || !/^[A-Z]{2,3}\d+[A-Z]\d?$/.test(document.publicationNumber)) throw new Error('문헌 식별자가 불완전합니다.');
  if (!/^https:\/\/patents\.google\.com\/patent\//.test(document.url)) throw new Error('공개 특허 문헌 URL이 아닙니다.');
  if (document.verificationStatus !== 'ABSTRACT_AND_CLAIMS_REVIEWED' || !document.legalReviewRequired) throw new Error('변리사 재검토 상태가 누락되었습니다.');
  if (!Array.isArray(document.overlapAxes) || !document.overlapAxes.length || !Array.isArray(document.differentiationQuestions) || !document.differentiationQuestions.length) throw new Error('문헌별 겹침·차이점 조사축이 없습니다.');
}
if (!Array.isArray(source.candidateDocuments) || source.candidateDocuments.length < 3) throw new Error('추가 조사 후보 문헌이 누락되었습니다.');
for (const candidate of source.candidateDocuments) {
  if (!/^PA-C-\d{3}$/.test(candidate.id) || !/^[A-Z]{2,3}\d+[A-Z]\d?$/.test(candidate.publicationNumber)) throw new Error('추가 조사 후보 식별자가 불완전합니다.');
  if (!/^https:\/\/patents\.google\.com\/patent\//.test(candidate.url)) throw new Error('추가 조사 후보 URL이 공개 특허 페이지 형식이 아닙니다.');
  if (candidate.verificationStatus !== 'PENDING_OFFICIAL_CLAIM_REVIEW' || !candidate.legalReviewRequired) throw new Error('추가 조사 후보 상태가 부정확합니다.');
  if (candidate.sourceCheckDate !== source.researchDate || !/^.+_CLAIMS_PENDING$/.test(candidate.sourceCheckStatus || '') || !candidate.sourceCheckNote) throw new Error('추가 조사 후보의 공개 페이지 확인 수준이 기록되지 않았습니다.');
  if (!Array.isArray(candidate.overlapAxes) || !candidate.overlapAxes.length || !Array.isArray(candidate.differentiationQuestions) || !candidate.differentiationQuestions.length) throw new Error('추가 조사 후보별 겹침·차이점 조사축이 없습니다.');
}
if (source.supplementalSearches !== undefined) {
  if (!Array.isArray(source.supplementalSearches)) throw new Error('보충 선행기술 검색 결과 형식이 잘못되었습니다.');
  for (const search of source.supplementalSearches) {
    if (!/^PA-S-\\d{3}$/.test(search.id) || !/^[A-Z]{2,3}\\d+[A-Z]\\d?$/.test(search.publicationNumber)) throw new Error('보충 선행기술 식별자가 불완전합니다.');
    if (!String(search.url || '').startsWith('https://patents.google.com/patent/')) throw new Error('보충 선행기술 URL이 공개 특허 페이지 형식이 아닙니다.');
    if (search.verificationStatus !== 'PENDING_OFFICIAL_CLAIM_REVIEW' || search.searchScope !== 'SUPPLEMENTAL_PUBLIC_PAGE_REVIEW' || !search.legalReviewRequired) throw new Error('보충 선행기술의 법률 검토 경계가 부정확합니다.');
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(search.sourceCheckDate) || !/^.+_CLAIMS_PENDING$/.test(search.sourceCheckStatus || '') || !search.sourceCheckNote) throw new Error('보충 선행기술의 확인 수준이 기록되지 않았습니다.');
    if (!Array.isArray(search.overlapAxes) || !search.overlapAxes.length || !Array.isArray(search.differentiationQuestions) || !search.differentiationQuestions.length) throw new Error('보충 선행기술의 겹침·차이점 조사축이 없습니다.');
  }
}
if (!Array.isArray(source.requiredNextReview) || source.requiredNextReview.length < 3) throw new Error('추가 전문 검토 항목이 부족합니다.');
console.log(`patent prior-art contract: PASS (${source.documents.length} documents)`);

