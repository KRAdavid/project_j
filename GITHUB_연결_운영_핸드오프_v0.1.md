# GitHub 연결·운영 핸드오프

버전: v0.1  
대상: Raw Material OS 베타 → 폐쇄형 Shadow Pilot → 상용 전환

## 현재 상태

이 로컬 프로젝트에는 GitHub Actions 품질 게이트, BM특허 추적성 검사, 운영 데몬 검사, 상용 전환 수동 게이트가 준비되어 있다. 현재 대상은 `KRAdavid/project_j`, `origin`은 해당 저장소, 기준 브랜치는 `main`으로 연결·검증되었다. 원격 저장소는 비어 있으며 외부 GitHub 쓰기, 커밋, PR 생성은 아직 실행하지 않았다.

현재 게시 사전점검은 `BLOCKED`이다. 필수 파일 누락과 강한 비밀값 패턴은 없지만, 로컬 브랜치가 `master`이고 기준 브랜치가 `main`이며 미스테이징·미추적 파일이 있어 초기 커밋 범위를 인간이 검토해야 한다.

## 연결에 필요한 최소 입력

다음 네 값을 확인한 뒤에만 연결한다.

1. `GITHUB_REPOSITORY`: `소유자/저장소명`
2. `origin`: 해당 GitHub 저장소의 HTTPS 또는 SSH URL
3. `GITHUB_BASE_BRANCH`: 실제 기준 브랜치명
4. 저장소에 대한 인증: 로컬 자격 증명 또는 CI용 GitHub 권한

인증 토큰·비밀번호·DB 접속정보·Object Storage 키는 이 저장소와 `.env` 파일에 기록하지 않는다.

## 안전한 연결 순서

```powershell
git remote add origin <실제-GitHub-저장소-URL>
$env:GITHUB_REPOSITORY = '<소유자>/<저장소명>'
$env:GITHUB_BASE_BRANCH = '<실제-기준-브랜치>'
pnpm run github:preflight
pnpm run github:publication-preflight
```

결과가 `TARGET_MATCH`이고 네 검사가 모두 `ready: true`일 때만 저장소 대상이 일치한 것으로 본다. 결과가 `BLOCKED`이면 값을 추측하거나 우회하지 않는다.

게시 전에는 다음 게이트도 통과해야 한다.

```powershell
pnpm run github:publication-preflight
```

결과가 `READY_FOR_EXPLICIT_PUSH`가 아니면 브랜치 변경·스테이징·커밋·푸시를 자동 실행하지 않는다. 로컬 `master`를 `main`으로 변경할지, `master`를 원격 `main`으로 매핑할지는 H-01 또는 지정 릴리스 담당자가 결정한다.

두 선택지의 영향과 승인 기록 양식은 `GITHUB_초기반영_결정패킷_v0.1.md`에 정리되어 있다.

## 연결 후 검증 순서

```powershell
pnpm install --frozen-lockfile
pnpm run ops:validate
pnpm run ops:preflight
```

GitHub Actions에서는 다음을 확인한다.

- push·pull request 품질 게이트 실행
- PostgreSQL·Object Storage 기반 스테이징 컨테이너 smoke test
- Material Master·증빙·Lot·예약·체결 스냅샷·분쟁 격리 테스트
- BM특허 구성요소·선행기술 추적성 검사
- 자동운영 데몬·승인함·알림 대기함 검사
- 회사 운영 감독자 프로세스의 생존·heartbeat 증거 검사
- 운영 사이클 증거 아티팩트 저장

## 상용 전환 원칙

GitHub 연결이나 CI 통과만으로 상용 전환하지 않는다. PostgreSQL 영속 원장, 서명 인증·RBAC, 가격 출처 승인, 외부 모니터링, 회사 운영 감독자 heartbeat, 백업·복구 리허설, H-01 Shadow Pilot 승인이 모두 확보되어야 `GO`가 된다.

`R-05`는 다음 네 가지 증거가 모두 있어야 통과한다: `MONITORING_CONNECTED`, `MONITORING_HEARTBEAT_VERIFIED`, `SUPERVISOR_CONNECTED`, `SUPERVISOR_HEARTBEAT_VERIFIED`. 하나라도 없거나 오래된 경우 운영 제어탑은 `NO_GO`를 유지하고 신규 체결·계약·결제·분쟁 종결은 fail-closed로 차단한다.

`production-cutover-gate.yml`은 증거를 검증하지만 자동 배포·거래·계약·결제·분쟁 종결을 실행하지 않는다. 최종 실행은 H-01과 지정 릴리스 책임자가 별도로 결정한다.

## 특허 자료 취급

특허 자료는 발명 설명·구현 추적·선행기술 조사용이다. 공식 선행기술 검색, 청구항 작성, 진보성·법적 상태·국가별 권리 검토는 변리사가 수행해야 하며, 본 프로젝트는 특허 등록이나 독점성을 보장하지 않는다.
