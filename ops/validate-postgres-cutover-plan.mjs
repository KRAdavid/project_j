import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const plan = await readFile(resolve(root, 'PG_상용원장_연결_마이그레이션_복구_실행계획_v0.1.md'), 'utf8');
const requiredSections = [
  '## 전환 전제', '## 표준 실행 순서', '## 복구 절차', '## 중단 기준',
  'APP_ENV=production', 'PERSISTENCE_MODE=postgresql',
  'DATABASE_URL=<secret-manager에서 주입>', 'PERSISTENCE_SCHEMA_APPLIED=true', 'POSTGRES_DOMAIN_ADAPTER_READY=true',
  'BACKUP_DRILL_PASSED=true', 'TRANSACTION_ISOLATION_VERIFIED=true', 'AUDIT_POLICY_APPLIED=true',
  'OBJECT_STORAGE_READY=true', 'EVIDENCE_STORE_READY=true', 'AUTH_PROVIDER_READY=true',
  'OBJECT_STORAGE_ENDPOINT=<secret-manager에서 주입하지 않는 공개 endpoint>',
  'OBJECT_STORAGE_BUCKET=<secret-manager에서 주입>',
  'OBJECT_STORAGE_ACCESS_KEY=<secret-manager에서 주입>',
  'OBJECT_STORAGE_SECRET_KEY=<secret-manager에서 주입>',
  'OBJECT_STORAGE_REGION=<secret-manager에서 주입>',
];
for (const section of requiredSections) {
  if (!plan.includes(section)) throw new Error(`PostgreSQL 전환계획 필수 항목이 없습니다: ${section}`);
}
console.log('postgres cutover plan tests: PASS');

