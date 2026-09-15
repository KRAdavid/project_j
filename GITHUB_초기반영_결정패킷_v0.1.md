# GitHub 초기 반영 결정 패킷

버전: v0.1  
대상: `KRAdavid/project_j`  
결정권자: H-01 또는 지정 릴리스 책임자

## 현재 확인된 사실

- `origin`: `https://github.com/KRAdavid/project_j.git`
- 원격 기준 브랜치: `main`
- 원격 저장소: 비어 있음, 기존 커밋 없음
- 로컬 기준 브랜치: `master`
- GitHub 대상 사전점검: `TARGET_MATCH`
- 필수 공개 파일: 누락 없음
- 강한 비밀값 패턴: 발견 없음
- 작업 트리: 미스테이징·미추적 파일 존재
- 외부 GitHub 쓰기: 아직 없음

근거 명령은 `pnpm run github:publication-preflight`이며, 현재 결과는 `BLOCKED`이다. 이 결과는 결함이 아니라 초기 커밋 범위와 브랜치 전략을 인간이 확인하도록 하는 안전 게이트이다.

## 권장 결정

### 옵션 A · 로컬 브랜치를 `main`으로 변경 후 반영 (권장)

원격 저장소가 비어 있고 로컬 커밋도 없으므로 브랜치 매핑 없이 동일한 이름으로 관리할 수 있다. 이후 초기 파일 범위를 검토·스테이징하고 `main`에 반영한다.

장점: 브랜치명 혼동이 없고 GitHub 기본 브랜치와 로컬 작업 기준이 일치한다.  
주의: 브랜치 변경과 초기 커밋 범위는 실행 직전 인간 확인이 필요하다.

### 옵션 B · 로컬 `master` 유지 후 원격 `main`으로 매핑

로컬 브랜치를 유지하고 푸시 시 명시적으로 `master:main`을 지정한다.

장점: 로컬 브랜치 이름을 바꾸지 않는다.  
주의: 이후 로컬 `master`와 원격 `main`의 분기·추적 관계를 계속 관리해야 한다.

## 승인 후 실행 순서

아래 명령은 이 문서 작성 시 실행하지 않았다. 결정권자가 옵션을 선택하고 초기 파일 범위를 검토한 뒤에만 수행한다.

```powershell
# 옵션 A를 선택한 경우에만
git branch -m master main

# 검토된 파일만 스테이징한다. 무조건적인 자동 공개를 의미하지 않는다.
git add <검토된 파일 목록>
git diff --cached --check
pnpm run github:publication-preflight
git commit -m "feat: establish Raw Material OS beta"
git push -u origin main
```

`github:publication-preflight`가 `READY_FOR_EXPLICIT_PUSH`가 아니면 커밋·푸시를 중단한다. GitHub Actions 통과만으로 상용 운영을 승인하지 않으며, PostgreSQL·인증/RBAC·가격원천·모니터링·백업복구·Shadow Pilot 조건은 별도 상용화 게이트로 유지한다.

## 결정 기록

- 선택 옵션: `A / B / 보류`
- 승인자: `________________`
- 승인 시각: `________________`
- 초기 커밋 범위 검토 완료: `예 / 아니오`
- 외부 푸시 승인: `예 / 아니오`

이 패킷은 의사결정 자료이며 AI가 브랜치 변경·커밋·푸시·PR·배포를 자동 실행하지 않는다.
