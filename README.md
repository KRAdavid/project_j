# 원료마켓 · Raw Material OS

검증된 실물 원료를 구매자와 공급자가 같은 거래 조건으로 확인하고 체결하는 B2B 원료 거래 플랫폼의 GABA 파일럿 저장소입니다.

## 제품 정의

이 프로젝트는 자본시장형 상품이 아니라 실물 원료의 다음 흐름을 단순하게 운영하는 것을 목표로 합니다.

```text
원료명 입력 → 거래 스펙 확정 → 검증된 로트 확인
→ 구매자 가격·수량·납기 주문 → 공급자 수락·부분수락·거절
→ 로트 잠금 → 체결 기록 → 납품·검수·정산
```

사용자 화면은 단순하게 유지하고, 내부에서는 스펙·증빙·로트·재고 상태를 엄격히 검증합니다.

## 현재 구현

- `beta-app/`: GABA 구매자·공급자 분할 시뮬레이션 UI
- 거래 전 4가지 확인: 스펙 일치, 증빙 유효, 검증 로트, 가용재고
- 가용재고 초과 주문 자동 차단
- 상용 주문은 구매 조직별 멱등 키를 저장해 네트워크 재시도 시 동일 주문을 반환하고, 같은 키의 내용 변경은 차단
- 납품·검수·완료 거래 가격 기록도 재전송 시 같은 결과만 반환하며, 종결 검수의 다른 판정은 차단
- 공급자 수락도 이미 체결된 주문·로트의 수량·가격·스펙이 다르면 `ACCEPT_RETRY_MISMATCH`로 거부하고, 같은 요청만 기존 체결을 반환
- 역제안·거절·만료·증빙 검토도 종결 상태의 동일 재시도만 반환하고, 다른 조건·판정은 재변경을 차단
- 구매자 주문 제출 → 공급자 응답 → 체결 상태 공유
- 서버 원장 상태를 새로고침 후에도 복원하는 상태 동기화
- Evidence-Locked Inventory 상태머신과 예약·납품·검수·분쟁 상태 분리
- API 상태 스냅샷에 체결 근거용 예약·검수 기록 포함
- `data/material-master.json`으로 표준 원료·동의어·근거 상태를 분리 관리
- `GET /api/materials/search`는 Material Master 후보를 정확·접두·부분일치 순으로 찾지만 스펙 확정은 수행하지 않습니다. 애매한 후보는 사용자가 선택하고 필수 문답을 완료해야 거래용 Spec이 생성됩니다.
- `beta-app/trade-terms.mjs`가 Material Master의 통화·가격단위·수량단위를 단일 거래조건으로 제공하고 주문·매물·체결에 봉인
- `data/price-index-policy.json`과 `beta-app/price-index.mjs`로 표본 부족 시 가격값을 숨기는 정책 적용
- 가격 표본은 현재 기준을 `KRW_PER_KG / KG / KRW`로 고정하고, 단위·통화가 다른 관측치는 수집·계산·PostgreSQL 원장에서 거부
- `data/postgres-schema.sql`로 조직권한·증빙·로트·예약·체결·감사 원장 영속화 기준 정의
- `data/evidence-policy.json`과 `beta-app/evidence-verifier.mjs`로 거래 전 필수 증빙 번들 검증
- `data/price-source-contract.json`으로 가격원천·품질검사·공개 승인 조건 고정
- `beta-app/price-feed.mjs`로 허용된 가격 원천의 필드·중복·표본을 검사하고 근거 부족 시 AI 추세를 공개하지 않음
- 가격 표본이 충분해도 `PRICE_SOURCE_APPROVED=true`와 승인 참조가 없으면 `PENDING_HUMAN_APPROVAL`로 반환해 AI 가격·추세의 무승인 공개를 차단
- `data/authorization-policy.json`으로 조직별 권한과 AI·인간 승인 경계 고정
- `beta-app/authorization.mjs`와 서버 API 권한 게이트로 구매자·공급자·운영자 역할을 분리하고, 상용 모드에서는 위조 가능한 역할 헤더 대신 만료·서명·조직 클레임을 검증한 Bearer 토큰만 허용하며 기동 시 `AUTH_JWT_SECRET` 설정도 fail-closed로 확인
- 역할별 원장 스냅샷 투영과 SSE 변환으로 구매자·공급자는 자기 조직 범위만 조회하고 내부 공급자 ID·증빙 원문은 노출하지 않음
- 공개 스냅샷 투영 단계에서도 만료 증빙·비활성·재고 0 로트를 숨겨, 구매자 화면에 오래된 검증 매물이 남지 않도록 함
- `beta-app/evidence-registry.mjs`로 증빙 제출·인간 검토·거래 전 적격성 상태 관리
- `beta-app/document-storage.mjs`로 증빙 원문·SHA-256 일치 여부와 S3 호환 Object Storage 상용 어댑터 경계를 관리하며, 원문 저장 실패 시 증빙을 만들지 않음
- 완료된 실물 거래의 가격 관측치를 `price_observations` 원장에 저장·복구하여 서버 재시작 후에도 가격지표 근거를 보존
- `ops/release-readiness.json`으로 필수 상용화 조건 미충족 시 자동 NO-GO
- `/api/health`와 `data/persistence-config.json`으로 메모리 베타와 PostgreSQL 상용 전환 상태를 명시
- `ops/incident-ledger.mjs`와 `ops/monitor-beta.mjs`가 모니터링 사고·반복·복구를 append-only 원장으로 보존하고 최초 사고만 H-01 승격 대상으로 표시하며, 외부 알림 또는 회사 운영 감독자 heartbeat 증거가 없으면 R-05를 완료 처리하지 않음
- `ops/notification-outbox.mjs`가 상용 전환 불가·모니터링 사고·H-01 검토 필요·승인 SLA 초과를 중복 없이 영속 알림 대기함에 기록하고 운영 제어탑에 투영합니다. 현재는 `OUTBOX_ONLY`이며 승인된 외부 알림 채널을 연결하기 전에는 자동 발송하지 않습니다.
- `ops/notification-dispatcher.mjs`는 승인된 웹훅과 명시적 활성화 플래그가 있을 때만 대기 알림을 멱등 전송하고, 시뮬레이션·미설정·전송실패를 각각 `OUTBOX_ONLY`·`BLOCKED`·`DELIVERY_FAILED`로 기록합니다. 알림 전송은 거래 승인이나 분쟁 종결을 수행하지 않습니다.
- 운영자는 제어탑에서 알림 수신을 확인할 수 있고, `POST /api/ops/notifications/{notificationId}/ack`가 append-only 확인 기록과 멱등 재시도를 보장합니다. AI는 알림을 생성·분석할 수 있지만 확인 완료나 운영 승인으로 상태를 바꿀 수 없습니다.
- `ops/test-incident-rehearsal.mjs`가 연결 불가·SSE heartbeat 중단·복구를 임시 환경에서 재현해 사고 감지와 원장 회복 기록을 검증
- `/api/readiness`로 H-01 승인 전 상용 전환 필수조건을 `GO/NO_GO`와 누락 항목으로 단일 조회
- `/api/ops/summary`와 `?role=operator` 운영 제어탑으로 업무 큐·승인 대기·자동 트리거·운영 알림 대기함·최근 실행·상용 전환 상태·참여 팀 권한·회사 운영 감독자 생존/재시작 상태를 별도 투영
- `pnpm run ops:cycle`로 운영 사이클을 1회 실행하고, `pnpm run ops:daemon`으로 스테이징 운영 사이클을 주기 실행할 수 있으며, `OPS_DAEMON_INTERVAL_MS`·`OPS_DAEMON_CYCLE_TIMEOUT_MS`·`OPS_DAEMON_MAX_CYCLES`·`--once`를 지원합니다. 사이클 타임아웃·종료·중복 실행은 잠금과 검토 로그로 보호되고, `ops/daemon-status.json`에 생존·사이클 상태를 기록합니다.
- `pnpm run ops:start`는 기본적으로 감독형 회사 모드(`ops/start-company-supervised.ps1`)를 실행합니다. canonical `beta-app/server.mjs`·운영 데몬·회사 운영 감독자를 함께 기동하고, health·SSE·생존 상태를 감시합니다. 포트 충돌·헬스체크 시간초과·반복 장애 시 안전하게 시작 또는 재시작을 중단합니다. `pnpm run ops:start:basic`은 감독자 없이 기존 기본 런처를 명시적으로 선택할 때만 사용합니다.
- 감독형 런처에 `-PersistenceMode sqlite -PersistenceFile <경로>`를 지정하면 SQLite 실험 런타임 플래그까지 서버 자식 프로세스에 전달해 베타 재시작 복구를 검증할 수 있습니다. SQLite는 상용 PostgreSQL 원장을 대체하지 않습니다.
- 감독자 상태는 `/api/ops/summary`와 운영 제어탑에 투영되며, `pnpm run ops:stop`은 감독자·데몬·서버를 모두 기록된 PID 기준으로 종료합니다. 두 런처 모두 배포·GitHub 쓰기·실거래 권한을 수행하지 않습니다.
- `pnpm run ops:register`는 사용자 로그온 시 감독형 회사 모드를 시작하고 최대 3회 재시작하는 Windows 작업 스케줄러 등록 패킷입니다. 기존 작업은 기본적으로 덮어쓰지 않으며, 현재 사용자 권한으로 등록할 수 없으면 실패를 명확히 보고하므로 관리자 PowerShell에서 재실행해야 합니다.
- `pnpm run ops:supervise`는 회사형 런타임의 감독 프로세스입니다. canonical 서버와 운영 데몬을 기동한 뒤 health·SSE 정체성·데몬 상태를 주기 확인하고, 제한된 횟수만 자동 재시작합니다. 반복 장애·기존 canonical 서버 감지·재시작 한도 초과 시 `HALTED_REQUIRES_H01`로 안전 정지하며, 실제 거래·계약·결제 권한은 절대 열지 않습니다. 재시작 정책과 상태는 `ops/company-supervisor-status.json`에 기록합니다.
- 회사형 런처는 자동 품질 사이클이 완료되기 전에 데몬이 끊기지 않도록 `CycleTimeoutMs`를 최소 300초로 강제합니다. 단회 타임아웃 회귀 테스트는 별도 격리된 데몬 프로세스로만 실행됩니다.
- 회사형 런처는 최근 heartbeat가 유효한 기존 운영 데몬을 singleton으로 판정해 `DAEMON_ALREADY_RUNNING`으로 중복 기동을 차단합니다. 운영 Lock은 이 가드의 보조선으로 유지됩니다.
- `pnpm run ops:stop` 또는 `ops/stop-company-mode.ps1`는 런타임 manifest에 기록된 운영 데몬·서버 런처만 정지하고 manifest를 `STOPPED`로 보존합니다. 기록되지 않은 프로세스나 기존 포트를 임의로 종료하지 않습니다.
- 종료된 자동업무는 `ops/task-queue-archive.jsonl`에 append-only로 보관하고 활성 큐에서 자동 압축하여 장기 운영 시 큐 크기와 중대 미해결 지표가 누적되지 않도록 합니다.
- `ops/task-audit-integrity.mjs`가 활성·아카이브 업무의 생명주기 시간 순서를 감사하며, 과거 아카이브의 시간 역전은 원본을 덮어쓰지 않고 정정 이벤트를 append-only로 남겨 복구합니다. 활성 업무의 시간 역전은 자동 수정하지 않고 H-01 검토로 승격합니다.
- `ops/task-audit-remediation.mjs`가 활성 감사 오류에 대한 정정 계획을 자동 생성하고, H-01 승인·원장 시그니처 재확인·append-only 정정 로그를 모두 통과한 경우에만 자동 적용합니다. 승인 전·계획 불일치·비안전 유형은 변경하지 않습니다.
- `ops/latest-cutover-input-manifest.md`는 미충족 릴리스 조건을 담당 AI·검토자·필요 환경 키·H-01 결정으로 자동 분해하며, 값·비밀은 기록하지 않습니다.
- `pnpm run ops:preflight`로 Node·`pg` 드라이버·Docker·PostgreSQL 연결정보를 비밀값 노출 없이 사전 점검하며, `--strict`에서는 하나라도 빠지면 비정상 종료해 마이그레이션·실거래 전환을 막음
- `pnpm run github:preflight`로 `GITHUB_REPOSITORY`·`origin`·기준 브랜치가 일치하는지 확인하며, `--strict`에서는 대상이 불명확할 때 외부 GitHub 쓰기를 차단
- 실제 GitHub 저장소가 제공되면 `ops/configure-github-target.ps1 -RepositoryUrl <URL> -Repository <소유자/저장소> -BaseBranch <기준브랜치>`로 origin·대상·기준 브랜치를 검증·연결할 수 있습니다. 불일치 시 `-ReplaceOrigin` 없이는 변경하지 않으며, commit·push·PR·배포는 실행하지 않습니다.
- `pnpm run github:publication-preflight`는 초기 반영 전 필수 파일·강한 비밀값 패턴·로컬/원격 브랜치 전략을 검사하며, `READY_FOR_EXPLICIT_PUSH`가 아니면 커밋·푸시를 시작하지 않습니다.
- `pnpm run github:staging-review`는 초기 커밋 후보를 category별로 staged·unstaged·untracked 상태로 분류해 인간 검토 패킷을 만들며 파일을 자동 변경하지 않습니다.
- `pnpm run ops:validate`로 참여 팀 명부·업무 담당/검토자·인간 승인 게이트·BM 특허 추적성·선행기술 원장·모니터링·릴리스 정책을 한 번에 확인
- `ops/validate-contracts.mjs`는 환경 의존 통합 테스트와 분리된 UI·Material Master·PostgreSQL·GitHub·특허·Shadow Pilot·알림·업무 감사·운영 요약·회사 감독자 계약 33종을 30초 제한으로 반복 검증합니다.
- `ops/goal-contract.mjs`와 `ops/goal-compiler.mjs`는 자연어 목표를 Universal Goal Contract로 정규화하고 GABA Domain Pack·완료 술어·첫 읽기 행동을 연결합니다. `/api/goals/compile`은 `PREPARE_ONLY` 결과만 반환하며 외부 쓰기·거래·계약·결제를 실행하지 않습니다.
- `ops/outcome-ledger.mjs`는 작업 개수가 아닌 완료 술어별 증거등급·신뢰도·유효기간으로 목표 진척을 계산합니다.
- `.github/ISSUE_TEMPLATE/`와 `PULL_REQUEST_TEMPLATE.md`로 중대 장애·BM특허 후보·변경 안전성 검토를 같은 형식으로 수집
- `.github/workflows/production-cutover-gate.yml`은 GitHub `production` 보호 환경에서만 수동으로 실행되며 마이그레이션·백업복구·릴리스 `GO`를 확인하고 자동 배포 없이 종료
- `/api/spec-compile`로 원료명·답변을 거래용 Spec 초안으로 컴파일하고, 미답변·허용값·검증 로트 일치 여부를 구분
- PostgreSQL 주문은 문답으로 확정된 `spec_attributes`가 승인된 Material Master와 완전 일치해야 생성되며, 체결 스냅샷에서도 동일 속성을 재검증
- PostgreSQL `reserve_lot`은 로트별 트랜잭션 advisory lock을 멱등 키 조회보다 먼저 취득해 동일 요청 재시도와 서로 다른 주문의 동시 재고 차감을 직렬화하며, 계약 테스트가 잠금 순서와 초과예약 차단을 확인
- 전량수락·부분수락·역제안·거절·주문만료 상태와 재고잠금 규칙을 거래 원장에 적용
- 체결 후 납품·검수·이행완료를 기록하고 불일치 시 거래를 `DISPUTED`, 로트를 `QUARANTINED`로 전환
- 체결 스냅샷에 SHA-256 무결성 지문을 봉인하고 납품·검수 단계에서 변조 여부를 재검증
- SSE 기반 원장 이벤트 계약으로 구매자·공급자 화면의 서버 상태 동기화
- `data/realtime-event-contract.json`과 `/api/events`로 원장 이벤트 재연·연결 생존 기준 정의
- `ops/shadow-pilot-plan.json`으로 실제 주문·결제 없는 폐쇄형 운영 검증 시나리오 관리. 만료·재고 오류 시나리오는 전체 통계가 아니라 오류가 발생한 로트·날짜별 차단과 해당 로트의 거래 0건까지 확인
- `BM특허_선행기술조사_의뢰패킷_v0.1.md`로 구현 기반 특허 검토 자료 관리
- `BM특허_선행기술_차이점_초안_v0.1.md`로 공개 특허와의 1차 차이점·추가 조사 요청을 기록하며 특허성은 단정하지 않음
- `GABA_실물증빙_수집_검증_패킷_v0.1.md`로 실제 COA·SDS·TDS·LOT_TRACE·INVENTORY_PROOF·SUPPLIER_VERIFICATION 수집 필드와 거래 전 차단 기준을 고정하며, 실문서 수집 전에는 상용 거래를 열지 않음
- `GABA_가격원천_승인_검증_패킷_v0.1.md`로 완료 실물거래·공급자 견적·공개 참고자료를 분리하고 가격지표 표본·단위·공급자 다양성·AI 추세 공개 승인 기준을 고정
- 실시간 체결창·호가·최근 체결·이벤트 로그 시뮬레이션
- `B2B_원료거래_핵심도메인_및_BM특허후보_v0.1.md`: 도메인 기준 및 발명 후보
- `simulator/`: 시나리오 기반 거래 시뮬레이터와 테스트
- `TF_자동운영_워크플로우_v0.1.md`: 회사형 AI TF의 업무 카드·승인 게이트·중단 규칙
- `회사형_AI_자동운영_목표운영모델_v0.1.md`: 업무 큐·승인 원장·운영 제어탑·장애 대응·상용 전환 단계
- `ops/run-autopilot.mjs`: 작업 큐에서 다음 업무와 검토 패킷을 자동 생성하는 오케스트레이터. `--claim` 실행 시 queued 준비 업무만 working으로 인수하고 담당 AI·시각을 기록하며, 이미 working/review인 업무는 반복 인수하지 않음
- `ops/autopilot-selection.mjs`: 증거 지문·승인 대기·기존 패킷 수를 기준으로 같은 미결 업무의 검토 패킷을 반복 생성하지 않고, 미처리 업무를 순환 선택하는 자동 업무 스케줄러
- 자동 파일럿 증거에는 주문·공급자 수락·납품·검수·가격기록의 멱등성 회귀검사가 포함되어 네트워크 재시도 안전성을 매 사이클 재확인한다
- 자동 업무 증거 지문은 `checkedAt`·실행 ID·소요시간 같은 변동값을 정규화하므로, 동일한 결과를 새 장애로 오인하지 않으며 실제 상태·원인 변화가 있을 때만 재검토 패킷을 만든다
- 자동 품질 게이트는 테스트별 30초 상한을 적용하고, 출력이 PASS여도 프로세스가 상한을 넘기면 안전하게 `BLOCKED`로 판정하여 종료 누수·환경 과부하를 놓치지 않음
- `ops/trigger-engine.mjs`: 품질 실패·증거 공백·NO_GO·모니터링 사고·업무 메타데이터 공백을 감지해 중복 없는 승인 대기 업무를 자동 생성하고 미해결 업무를 실제 AI 작업 큐에 편입
- `ops/run-ops-cycle.mjs`: 모니터링 → 자동 품질 게이트 → 트리거 업무 생성·해소 재조정 → H-01 보고를 한 번에 실행
- `pnpm run ops:goal-audit`와 운영 사이클이 제품·자동운영·GitHub·인프라·BM특허 준비 상태를 요구사항별 `VERIFIED/PREPARED/BLOCKED`로 집계해 `ops/latest-goal-audit.*`에 남깁니다.
- `ops/latest-browser-e2e.json`: GABA 스펙 확정 → 주문 → 공급자 체결·재고 예약 → 납품 → 검수 완료까지의 브라우저 시뮬레이션 증거(실거래·결제 없음)
- `GITHUB_연결_운영_핸드오프_v0.1.md`: 대상 저장소·origin·기준 브랜치 검증과 GitHub Actions·상용 전환 연결 순서
- `ops/executive-review.mjs`: 최신 사이클·릴리스 차단조건·승인 대기·스테이징/GitHub 사전점검을 한 장의 H-01 경영진 검토 패킷으로 자동 집계하며, 권고는 실거래 보류이고 승인 자체는 실행하지 않음
- 경영진 검토 패킷은 업무 생명주기 감사 상태·활성 위반 수·정정 계획 ID·H-01 승인 대상을 함께 표시해, 승인 전 변경 금지와 승인 후 자동 재감사를 한 화면에서 판단할 수 있게 함
- `ops/approval-sla.mjs`: 위험도별 승인 SLA 초과 건을 자동 표시해 H-01 검토를 재촉구하며, 외부 알림 연동 전에는 메시지를 발송하거나 승인 상태를 변경하지 않음
- `ops/task-sla.mjs`: queued·working·review 업무의 위험도별 SLA를 자동 평가하고, 기한 초과 업무를 AI-01·H-01 상향보고 트리거로 변환합니다. 생성·인수 시각이 없는 업무는 시간을 추정하지 않고 `TASK_METADATA_GAP`으로 먼저 보류합니다.
- `beta-app/domain-reconciliation.mjs`: 정규 PostgreSQL 원장과 기존 스냅샷 투영의 핵심 상태를 비교하고 불일치 시 안전하지 않은 상태로 판정
- PostgreSQL 환경의 SSE 초기 스냅샷·변경 이벤트는 정규 도메인 원장에서 투영되며, 시뮬레이션 스냅샷과 혼용하지 않음
- `beta-app/authorization.mjs`: 구매자·공급자 투영에서 상대 조직 식별자와 증빙 원문 해시·저장참조를 역할별로 차단
- PostgreSQL 매물 등록은 `PENDING_VERIFICATION` 초안으로 시작하며, 5종 증빙의 운영자 검토가 모두 끝난 경우에만 `VISIBLE` 오퍼를 생성
- PostgreSQL 매물 등록·주문 수락·역제안은 사업자 검증이 완료된 조직의 활성 SUPPLIER 멤버만 요청할 수 있으며, 조직 검증·멤버십·5종 증빙 중 하나라도 없으면 거래 후보 생성이 차단됨
- `/api/supplier/eligibility`가 공급자 조직 검증·활성 SUPPLIER 멤버십·로트별 필수 증빙 정책을 거래 전에 판정하며, 자동 확인 실패 시에도 신규 매물·체결은 fail-closed로 유지
- `/api/market-board?specId=GABA-SPEC-001`은 서버 원장에서 `VERIFIED_ELIGIBLE`·유효 증빙·양수 가용재고·표준 거래단위를 모두 통과한 매물만 호가로 투영하며, 공개 매수 호가는 별도 공개정책 승인 전까지 비활성화
- `beta-app/test-market-board-lifecycle.mjs`는 체결 전 호가·체결 후 비완료 상태·납품·검수 완료 후 실물 체결가 공개·가격지표 표본 편입의 전체 수명주기를 임시 서버에서 검증하며, 단일 거래로 평균가격을 공개하지 않음
- `/api/supplier/verification-request`가 신규 공급자의 사업자·공급자 증빙 참조를 PostgreSQL에 접수하고 `REQUESTED` 상태로 보관하며, H-01 또는 지정 운영자 승인 전에는 자격을 열지 않음
- `/api/supplier/verification-requests/{requestId}/review`는 H-01의 검토 진행 승인 이후 권한 있는 인간이 최종 증빙을 확인할 때만 조직 `verified_at`을 기록하며, 메모리 베타에서는 의도적으로 차단됨
- `data/postgres-domain-adapter-contract.json`: 스냅샷 브리지에서 정규 PostgreSQL 도메인 원장으로 전환하기 위한 상용 게이트와 원자 쓰기 계약
- `ops/approval-store.mjs`: H-01의 승인·수정요청·보류·거절을 단일 결정과 감사 로그로 기록
- `ops/autopilot-ledger.mjs`: 기존 미해결 자동 트리거도 승인함으로 누락 없이 동기화하며, 이미 결정된 항목을 자동 재결정하지 않음
- `simulator/shadow_pilot_runner.py`와 `ops/run-shadow-pilot.mjs`: 7개 폐쇄형 Shadow Pilot 시나리오를 자동 실행하고 성공 기준을 판정
- Shadow Pilot은 실행 전에 폐쇄모드·실거래/금전/외부알림 차단·H-01 승인·참가자 역할·중단 기준·증거 계약을 fail-closed로 점검하며, 설정 오류 시 시나리오와 참가자 접근을 모두 중단
- `ops/autopilot-ledger.mjs`: 자동 실행 이력 누적과 H-01 승인 대기열 생성
- `ops/work-packet.mjs`와 `ops/work-packets.jsonl`: 선택 업무의 담당 AI·검토자·증거·금지 권한을 자동 작업 패킷으로 누적
- `ops/patent-disclosure-packet.mjs`와 `ops/patent-disclosures.jsonl`: 7개 BM특허 후보 요소를 변리사 검토용 설명 패킷으로 누적하되 특허성·법률 판단은 자동화하지 않음
- `ops/patent-claim-outline.mjs`: 7개 기술 요소를 독립항 구성요소·종속항 후보·기술적 효과로 정리하는 변리사 작성 보조 패킷을 생성하며 특허성·법률 판단은 하지 않음
- `TF_참여팀원_역할권한_명부_v0.1.md`: 인간 총괄 1명과 AI 가상 전문가 13명의 공식 역할·권한 명부
- `data/team-roster.json`: 운영 API·제어탑·품질 게이트가 공동 사용하는 참여 팀·자동권한 원본
- `data/patent-claim-traceability.json`: BM 특허 후보 구성요소를 구현 파일·테스트 증거·인간 검토 게이트에 연결한 발명 설명 추적 원본
- `data/patent-prior-art.json`와 `ops/validate-patent-prior-art.mjs`: 공개 특허 조회 페이지의 1차 대조 문헌·겹침축·차이점 조사축을 구조화하며, 정부 특허청 원문·패밀리·법적 상태와 변리사 검토 전에는 특허성·법률판단을 하지 않음
- 선행기술 원장은 공식 페이지에서 초록·청구항을 대조한 6개 `documents`와 URL·조사축만 확보한 3개 `candidateDocuments`를 분리해, 확인되지 않은 문헌을 검토 완료로 과장하지 않음
- `.github/workflows/quality-gates.yml`: push·PR·수동 실행·일일 스케줄로 반복 검증하고 AI TF 검토 패킷을 보관하는 자동 게이트
- GitHub Actions는 `pnpm@11.19.0`과 `pnpm-lock.yaml`을 고정 사용해 로컬·CI 의존성 트리를 일치시킨다

## 베타 실행

Node.js가 있으면 다음 명령으로 로컬 서버를 실행합니다.

```powershell
pnpm install --frozen-lockfile
cd beta-app
node server.mjs
```

브라우저에서 `http://127.0.0.1:4173/`을 엽니다. PowerShell에서는 `beta-app/server.ps1`도 사용할 수 있으며, 이 런처는 정식 `server.mjs`만 실행합니다. 별도 정적 서버를 사용하면 API·SSE·원장 검증이 빠지므로 운영 경로로 사용하지 않습니다.

현재 베타의 가격·재고·체결 이벤트는 시뮬레이션이며, 로컬 Node 백엔드와 연결되어 거래 수명주기·증빙 게이트·SSE를 검증합니다. 실제 주문·결제·문서 업로드·회원 인증은 상용 외부 시스템과 연결하지 않았습니다.

PostgreSQL 원장과 S3 호환 증빙 저장소를 재현하는 스테이징 기반은 `compose.staging.yml`에 정의되어 있습니다. `schema-migrate → app healthcheck → ops-daemon` 순서를 Compose dependency 조건으로 고정하여 서버와 회사형 운영 사이클까지 재현합니다. Object Storage bucket 초기화는 서버 준비를 재시도한 뒤 완료되며, GitHub Actions는 Compose 전체 기동·`/api/health` smoke test·정리를 자동 실행합니다. Docker Compose가 설치된 환경에서 `docker compose -f compose.staging.yml up -d`로 시작하고, `.env.staging.example`을 시크릿 관리 환경에 맞게 주입한 뒤 백업·동시성 리허설을 수행합니다. 예제 파일의 상용 전환 플래그는 모두 `false`이며, 증거 없이 값을 바꾸면 안 됩니다.

기본 서버는 메모리 모드로 안전하게 시작합니다. 재시작 복구를 시험할 때만 `PERSISTENCE_MODE=sqlite`와 `node --experimental-sqlite server.mjs`를 사용합니다. SQLite는 베타 검증용이며 상용 원장은 PostgreSQL·백업·복구 리허설·감사권한·정규 도메인 API 연결을 통과하기 전까지 공개하지 않습니다. 상용 PostgreSQL 모드는 `pg` 드라이버와 `DATABASE_URL`로 연결되고, 연결 시 핵심 테이블·`reserve_lot` 원자 예약 함수까지 직접 확인하며, 접속·저장·스키마 검증에 실패하면 메모리 모드로 폴백하지 않습니다. `POSTGRES_DOMAIN_ADAPTER_READY`와 `POSTGRES_DOMAIN_API_READY`는 각각 정규 원장과 전체 API 연결 증거가 H-01에게 승인된 뒤에만 설정합니다.

운영 감시 리허설은 서버가 실행 중일 때 `MONITOR_BASE_URL=http://127.0.0.1:4173 MONITOR_HEARTBEAT_TIMEOUT_MS=20000 MONITOR_REQUIRE_SUPERVISOR=true node ops/monitor-beta.mjs`로 수행합니다. health·SSE heartbeat·회사 운영 감독자 heartbeat·fail-closed 중 하나라도 실패하면 `INCIDENT`를 출력하고 운영 재개를 승인하지 않습니다.

운영 데몬은 프로세스 생존과 사이클 결정 결과를 분리 기록합니다. 사이클이 `HUMAN_REVIEW_REQUIRED` 또는 `INCIDENT_HUMAN_REVIEW_REQUIRED`로 종료되면 프로세스는 계속 감시하지만 `lastCycleDecision`과 `daemonReviewRequired`를 남기고, 운영 감시는 `DAEMON_CYCLE_REQUIRES_HUMAN_REVIEW`로 H-01 검토를 요구합니다. 이는 데몬 장애와 안전한 업무 중단을 혼동하지 않으면서도 실제 운영 재개는 차단하기 위한 장치입니다.

## 반복 검증

```powershell
cd beta-app
node test-trade-engine.mjs
cd ..
& 'C:\Users\fksak\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest discover -s simulator -p 'test_*.py'
```

## AI TF 자동 실행

```powershell
node ops/run-autopilot.mjs
# 회사형 자동 사이클에서는 준비 업무 자동 인수를 위해 다음처럼 실행
node ops/run-autopilot.mjs --claim
```

실행 결과는 `ops/latest-autopilot-run.json`과 `ops/latest-autopilot-run.md`에 남습니다. AI는 업무를 선택하고 검토 패킷을 만들 수 있지만, 실제 거래·계약·지급은 승인하지 않습니다.

각 실행은 `ops/autopilot-history.jsonl`에 누적되고, 인간 승인 대기 항목은 `ops/approval-inbox.json`에 생성됩니다. 승인 대기열은 AI가 자동 승인하거나 종료하지 않습니다. 새 실행 패킷은 과거 승인 상태를 자동 승계하지 않으며, 이전 결정은 참고 정보로만 남기고 H-01 재결정을 요구합니다.

품질 게이트 실패·검증 공백·상용 전환 `NO_GO`·모니터링 사고·업무 생명주기 메타데이터 공백은 `ops/trigger-engine.mjs`가 원인별 담당 AI 업무로 자동 변환하며, 중복 없는 `ops/trigger-inbox.json`에 누적합니다. 이 업무도 H-01 승인 전에는 실제 거래·계약·결제·운영 재개를 수행하지 않습니다.

운영자 승인 API는 `POST /api/ops/approvals/{approvalId}`이며 `OWNER` 권한이 필요합니다. 시뮬레이션에서는 `x-raw-user-id: H-01`인 인간 승인자만 사용할 수 있고, 승인 자체가 실제 거래·계약·결제 실행을 의미하지 않도록 분리되어 있습니다.

서버가 실행 중이면 다음 단일 명령으로 회사형 운영 사이클을 실행합니다.

```powershell
node ops/run-ops-cycle.mjs
```

결과는 `ops/latest-ops-cycle.json`과 `ops/latest-ops-cycle.md`에 기록됩니다.

폐쇄형 Shadow Pilot만 별도로 실행하려면 다음 명령을 사용합니다.

```powershell
node ops/run-shadow-pilot.mjs
```

자동 운영은 `요청 접수 → AI 역할별 검토 → 위험·법무 게이트 → 인간 사업총괄 승인 → 구현·검증 → 결정 로그` 순서로 고정합니다. 거래·문서·규제·정산처럼 사고 비용이 큰 영역은 AI가 단독 확정하지 않습니다.

사이클 결과가 `HUMAN_REVIEW_REQUIRED` 또는 `INCIDENT_HUMAN_REVIEW_REQUIRED`여도 운영 데몬은 프로세스 생존을 유지하고 다음 안전 사이클을 예약합니다. 단, 검토 대기 중인 거래·계약·결제·상용 운영 재개는 자동 실행하지 않으며, 데몬 자체 중단·타임아웃·재시작 한도 초과만 자동 정지 사유로 취급합니다.

## BM 특허 개발 방향

특허 후보의 중심은 단순한 가격 매칭이 아니라 다음의 기술적 연동 구조입니다.

```text
자연어 원료 요구
→ 표준 Spec ID 생성
→ Evidence·Lot·재고 상태 계산
→ 검증 통과 매물만 노출
→ 체결 직전 재검증·원자적 로트 잠금
→ 체결 당시 스펙·증빙·로트 스냅샷 보존
→ 증빙 변경 시 자동 격리
```

특허성은 선행기술 조사와 변리사 검토 후 판단합니다. 상세 후보는 도메인 문서를 기준으로 관리합니다.

