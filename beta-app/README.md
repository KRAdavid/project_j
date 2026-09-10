# 원료마켓 베타 테스트 환경

GABA를 대상으로 구매자와 공급자 흐름을 직접 시험하는 무설치형 프론트엔드 베타입니다.

## 제공하는 흐름

1. `GABA` 또는 `가바` 검색
2. 순도·제형·원산지·포장 단위 확정
3. 동일 스펙 평균 거래가와 AI 참고 지표 확인
4. 매수가·수량·희망 납기 입력
5. 주문 제출 및 주문 상태 확인
6. `분할 보기`에서 구매자·공급자 화면을 동시에 확인
7. `공급자` 역할로 전환해 검증 재고와 주문 체결 확인
8. 실시간 원료 체결창에서 가격·호가·최근 체결·이벤트 갱신 확인
9. Evidence-Locked Inventory의 예약·납품·검수·분쟁 상태 확인
10. 공급자 증빙 5종을 모두 인간 검토 완료한 뒤에만 신규 로트 등록
11. `운영자` 역할에서 AI 자동운영 실행·승인 대기·상용 전환 상태를 별도 확인
12. `/api/spec-compile`로 한 번에 하나씩 답변하는 스펙 컴파일 흐름과 미확정·불일치 상태 확인

## 분할 시뮬레이션 사용법

기본 화면은 `분할 보기`입니다. 왼쪽 구매자 화면에서 매수가와 수량을 입력하고 `구매 주문 제출`을 누르면, 오른쪽 공급자 화면의 주문이 즉시 활성화됩니다. 공급자가 `구매자 주문을 체결하기`를 누르면 양쪽 화면이 공유하는 시뮬레이션 상태가 `체결 완료`로 바뀝니다.

## 실행

Node.js가 있는 환경에서는 저장소에 포함된 무설치 서버를 실행합니다.

```powershell
node server.mjs
```

그 다음 브라우저에서 `http://127.0.0.1:4173/`을 엽니다.

운영 제어탑 시뮬레이션은 `http://127.0.0.1:4173/?role=operator`로 바로 열 수 있습니다. 이 화면은 운영 상태를 보여주기만 하며, AI가 실제 거래·계약·지급을 승인하지 않습니다.

핵심 체결 규칙 회귀 테스트:

```powershell
node test-trade-engine.mjs
```

테스트는 스펙 미확정 주문 차단, 거래 전 증빙 게이트, 멱등 주문·체결, 재고 잠금, 초과판매 차단을 확인합니다.

상태머신 모듈 테스트:

```powershell
node test-inventory-ledger.mjs
```

원장 이벤트 스트림 통합 테스트:

```powershell
node test-sse-integration.mjs
```

베타 원장 재시작 복구 테스트:

```powershell
node --experimental-sqlite test-persistence-store.mjs
node --experimental-sqlite test-server-persistence.mjs
```

SQLite 스냅샷 모드로 로컬 서버를 실행하려면 다음처럼 명시합니다. 이 모드는 개발·복구 리허설용이며 상용 원장은 PostgreSQL로 전환해야 합니다.

```powershell
$env:PERSISTENCE_MODE = 'sqlite'
$env:PERSISTENCE_FILE = "$PWD\..\data\beta-ledger.sqlite"
node --experimental-sqlite server.mjs
```

PowerShell에서 이 폴더로 이동한 뒤 다음 명령을 실행합니다.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\server.ps1
```

그 다음 브라우저에서 `http://127.0.0.1:4173/`을 엽니다.

Node.js 또는 Python이 있는 환경에서는 정적 서버로도 실행할 수 있습니다.

```powershell
node --version
python -m http.server 4173
```

## 베타 범위와 제한

- 현재 데이터는 모두 시뮬레이션 데이터입니다.
- `server.mjs`는 `/api/state`, `/api/market-board?specId=GABA-SPEC-001`, `/api/orders`, `/api/orders/:orderId/accept` 최소 거래 원장을 제공합니다.
- `/api/market-board`는 서버 원장의 `VERIFIED_ELIGIBLE` 로트 중 유효 증빙·가용 재고·표준 거래단위를 모두 통과한 매물만 반환합니다. 공개 매수 호가는 별도 공개정책 승인 전까지 빈 배열입니다.
- `server.mjs`는 `/api/materials`, `/api/materials/resolve?q=GABA`로 표준 원료·동의어 매칭 결과를 제공합니다.
- `POST /api/evidence`와 운영자 검토 후 `POST /api/lots`로 거래 전 증빙이 완비된 로트만 매물 등록을 허용합니다.
- 기본 원장은 안전한 시뮬레이션 메모리 모드입니다. `PERSISTENCE_MODE=sqlite`를 명시하면 베타 복구 리허설용 스냅샷 원장을 사용할 수 있습니다. `PERSISTENCE_MODE=postgresql`은 `pg` 드라이버와 `DATABASE_URL`이 실제로 연결될 때만 기동하며, 연결 실패 시 메모리 모드로 폴백하지 않습니다. 상용 전환 전에는 Object Storage·감사 이벤트 저장소도 별도 연결해야 합니다.
- 실제 회원가입·로그인·문서 업로드·결제·전자계약·알림·백엔드는 연결되어 있지 않습니다.
- 브라우저를 새로고침해도 서버 원장의 주문·체결 상태를 다시 불러옵니다. 메모리 모드의 서버 재시작 시 원장은 초기화되며, SQLite 모드는 마지막 저장 스냅샷에서 복구됩니다.
- 실제 공개 베타 전에는 공급자 인증, 재고 증빙, COA·규격서 유효성, 로트 잠금, 계약·배송·검수·정산 연계를 반드시 붙여야 합니다.
