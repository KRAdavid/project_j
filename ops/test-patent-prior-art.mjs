import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const result = spawnSync(process.execPath, ['ops/validate-patent-prior-art.mjs'], { cwd: root, encoding: 'utf8' });
if (result.status !== 0) throw new Error(`${result.stdout || ''}${result.stderr || ''}`);
const source = JSON.parse(await readFile(resolve(root, 'data', 'patent-prior-art.json'), 'utf8'));
if (source.documents.some((document) => !document.url.includes(document.publicationNumber))) throw new Error('문헌 번호와 URL이 일치하지 않습니다.');
if (source.candidateDocuments.some((document) => !document.url.includes(document.publicationNumber) || document.verificationStatus !== 'PENDING_OFFICIAL_CLAIM_REVIEW')) throw new Error('추가 조사 후보의 URL·검토 상태가 일치하지 않습니다.');
console.log('patent prior-art tests: PASS');

