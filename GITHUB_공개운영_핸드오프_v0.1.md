# 공개 운영 핸드오프 · Raw Material OS

버전: v0.1  
대상: `KRAdavid/project_j` 공개 베타

## 목적

이 문서는 공개 저장소를 인수한 운영자와 검토자가 자동 운영 범위, 안전 경계, 상용 전환 조건을 같은 기준으로 확인하기 위한 핸드오프입니다. 공개 베타는 GABA 실물 원료 거래 시뮬레이션이며, 실제 주문·계약·결제·참가자 접근을 승인하지 않습니다.

## 자동 운영 모델

운영 감독자는 다음 순서로 반복 실행합니다.

```text
모니터링 → 품질·거래 무결성 검증 → AI 업무 선택·증거 패킷 생성
→ 트리거 업무·승인 대기 갱신 → 목표·릴리스 감사 → 다음 사이클 예약
```

AI는 분석·검증·문서화·복구 준비를 자동 수행합니다. `HUMAN_REVIEW_REQUIRED` 또는 `INCIDENT_HUMAN_REVIEW_REQUIRED`가 발생해도 데몬은 다음 안전 사이클을 예약할 수 있지만, 다음 작업은 H-01 사업총괄 승인 전까지 자동 실행하지 않습니다.

- 실제 거래·계약·결제
- 참가자 접근 개방
- 원장 정정·승인 상태 변경
- PostgreSQL/Object Storage 상용 전환
- 가격지표·AI 추세의 공개 승인
- 공개 배포 또는 운영 재개

## 확인 명령

Node.js와 pnpm이 준비된 환경에서 다음 순서로 확인합니다.

```powershell
pnpm install --frozen-lockfile
pnpm ops:validate
pnpm ops:preflight
pnpm ops:goal-audit
```

로컬 베타는 `pnpm start:beta`로 실행하며, 기본 데이터 상태는 `SIMULATED_BACKEND`입니다. 회사형 감독 런타임은 `pnpm ops:start`를 사용하고, 종료는 `pnpm ops:stop`을 사용합니다. 기존 실행 중인 canonical 서버를 임의로 종료하지 않습니다.

## 상용 전환 필수조건

다음 조건이 모두 증거와 승인으로 확인되기 전에는 `GO`로 전환하지 않습니다.

- R-01: PostgreSQL 영속 원장·원자 예약·재조정 증거
- R-02: 서명 인증과 조직 RBAC 운영 증거
- R-03: 거래 전 원료·로트·증빙 검증
- R-04: 가격 원천의 권리·품질·표본·공개 승인
- R-05: 외부 모니터링·알림·heartbeat 증거
- R-06: PostgreSQL 백업·복구 리허설 원문과 검증 참조
- R-07: 폐쇄형 Shadow Pilot 범위·참가자·중단 기준에 대한 H-01 승인
- R-08: 전체 품질 게이트 통과

환경 키, 토큰, 비밀번호, DB 접속정보, Object Storage 비밀값은 저장소와 문서에 기록하지 않습니다. 사전점검이 실패하면 실거래·마이그레이션·공개 배포를 시작하지 않습니다.

## GitHub 인수·변경 절차

1. 공개 `main`의 현재 head SHA를 확인합니다.
2. 해당 SHA에서 `codex/` 브랜치를 만듭니다.
3. 변경 범위를 최소화하고 PR을 생성합니다.
4. PR 품질 게이트와 필요한 리뷰를 통과시킵니다.
5. 예상 head SHA를 고정해 병합합니다.
6. 병합 후 `main` push CI와 공개 파일을 다시 확인합니다.

자동화가 파일을 커밋·푸시·병합할 때도 위 순서를 건너뛰지 않습니다. 공개 반영 후보에 staged·unstaged·untracked 변경이 섞여 있으면 하나의 커밋으로 추측해 묶지 않고 검토 패킷을 먼저 생성합니다.

## 특허 자료의 취급

BM 특허 후보 문서와 구현 추적성은 변리사 검토를 위한 기술 자료입니다. 선행기술, 청구항, 진보성, 법적 상태, 등록 가능성은 이 저장소가 보장하지 않으며 변리사와 관할 전문가가 최종 판단합니다.

## 인수 시 확인할 공개 근거

- [PUBLIC_RELEASE_SCOPE.md](PUBLIC_RELEASE_SCOPE.md)
- [README.md](README.md)
- [ops/validate-contracts.mjs](ops/validate-contracts.mjs)
- [ops/goal-audit.mjs](ops/goal-audit.mjs)
- [ops/executive-review.mjs](ops/executive-review.mjs)
- [ops/company-supervisor.mjs](ops/company-supervisor.mjs)

이 문서는 운영자가 판단할 수 있도록 범위와 중단 기준을 정리한 자료이며, 어떠한 실거래·계약·결제·상용 전환도 수행하지 않습니다.
