# PostgreSQL 상용 원장 연결·마이그레이션·복구 실행계획 v0.1

## 목적

원료 거래의 주문·재고 잠금·체결·납품·검수 원장을 여러 서버 인스턴스에서 동일하게 처리하고, 장애 시 마지막 확정 상태로 복구한다. 실제 비밀번호·접속정보는 이 문서에 기록하지 않는다.

## 전환 전제

다음 조건이 모두 충족되기 전에는 `APP_ENV=production`을 허용하지 않는다.

1. 별도 개발·스테이징 PostgreSQL 15+ 인스턴스와 암호화된 `DATABASE_URL` secret
2. `data/postgres-schema.sql` 검토 및 마이그레이션 실행 기록
3. 백업 생성·복구 리허설 성공과 복구 시점/복구 시간 기록
4. `pg_advisory_xact_lock` 기반 원자 원장 변경과 트랜잭션 격리 검증
5. `trade_events` 및 `ledger_snapshots` append-only 접근정책
6. Object Storage 문서 어댑터와 durable evidence registry
7. H-01 승인, AI-11 보안 검토, AI-12 복구 검토

## 표준 실행 순서

### 1. 개발 환경

- 비밀값은 저장소에 기록하지 않고 런타임 환경변수로 주입한다.
- `npm ci`로 `pg` 런타임을 설치한다.
- 스키마를 새 데이터베이스에 적용하고 저장소·API 회귀 테스트를 실행한다.
- 두 개의 서버 프로세스에서 동시에 주문·체결을 발생시켜 한 번만 재고가 차감되는지 확인한다.

### 2. 스테이징

- 운영과 동일한 PostgreSQL 버전·인증·네트워크 정책을 적용한다.
- 스키마 적용 전후의 테이블·인덱스·함수 목록을 저장한다.
- 백업에서 새 인스턴스로 복구하고 주문·체결·감사 이벤트 수와 해시를 대조한다.
- DB 연결 단절, 중복 idempotency key, 재고 부족, 서버 중단 후 재기동을 주입한다.
- 모든 실패 시 거래 API가 fail-closed가 되는지 확인한다.

### 3. 상용 전환

다음 환경변수를 모두 제공한다.

```text
APP_ENV=production
PERSISTENCE_MODE=postgresql
DATABASE_URL=<secret-manager에서 주입>
PERSISTENCE_SCHEMA_APPLIED=true
POSTGRES_DOMAIN_ADAPTER_READY=true
POSTGRES_DOMAIN_API_READY=true
BACKUP_DRILL_PASSED=true
TRANSACTION_ISOLATION_VERIFIED=true
AUDIT_POLICY_APPLIED=true
OBJECT_STORAGE_READY=true
EVIDENCE_STORE_READY=true
AUTH_PROVIDER_READY=true
AUTH_JWT_SECRET=<secret-manager에서 주입, 최소 32자>
AUTH_JWT_ISSUER=<인증 제공자 issuer>
AUTH_JWT_AUDIENCE=<Raw Material OS API audience>
OBJECT_STORAGE_ENDPOINT=<secret-manager에서 주입하지 않는 공개 endpoint>
OBJECT_STORAGE_BUCKET=<secret-manager에서 주입>
OBJECT_STORAGE_ACCESS_KEY=<secret-manager에서 주입>
OBJECT_STORAGE_SECRET_KEY=<secret-manager에서 주입>
OBJECT_STORAGE_REGION=<secret-manager에서 주입>
```

배포 직전에는 자동 회귀 게이트와 H-01 승인 기록을 확인한다. 하나라도 누락되면 서버는 시작하지 않는다.

## 복구 절차

1. 거래 API를 읽기 전용 또는 점검 모드로 전환한다.
2. 마지막 성공 백업과 `ledger_snapshots`의 최신 `snapshot_id`를 확인한다.
3. 새 격리 인스턴스에 복구하고 `trade_events`의 correlation id를 기준으로 누락·중복을 대조한다.
4. AI-12가 복구 결과를 검토하고 H-01이 재개를 승인한다.
5. 재개 후 주문·예약·납품·검수 순서의 합성 거래를 수행한다.

## 중단 기준

- 재고가 음수가 되거나 예약 수량과 로트 수량이 불일치함
- 동일 idempotency key가 서로 다른 결과를 반환함
- 최신 원장 스냅샷과 관계형 원장 수가 불일치함
- 백업 복구 후 체결 이벤트가 재현되지 않음
- 감사 원장 UPDATE/DELETE 권한이 존재함
- PostgreSQL 연결 실패 후 서버가 메모리 모드로 계속 기동함

## 완료 판정

개발·스테이징에서 위 절차와 장애 주입을 모두 통과하고 H-01이 승인한 경우에만 상용 전환 검토 상태로 이동한다. 이 문서의 존재만으로 상용화나 특허 가능성을 보증하지 않는다.

