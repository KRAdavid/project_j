# GABA 베타 거래소 시뮬레이터

실제 거래·결제·AI API 없이 GABA 원료 거래소의 핵심 흐름을 재현하는 코드형 베이스라인이다.

## 실행

프로젝트 루트에서 다음을 실행한다.

```powershell
python -m unittest discover -s simulator -p "test_*.py"
python simulator/gaba_beta_simulator.py --scenario normal --output simulation_output/gaba_normal.json
python simulator/gaba_beta_simulator.py --scenario document_expiry --output simulation_output/gaba_document_expiry.json
python simulator/gaba_beta_simulator.py --scenario quality_mismatch --output simulation_output/gaba_quality.json --csv simulation_output/gaba_quality.csv
python simulator/gaba_beta_simulator.py --scenario demand_surge --runs 1000 --output simulation_output/gaba_demand_surge_monte_carlo.json
```

## 시나리오

- `normal`: 정상 거래
- `demand_surge`: 수요 급증
- `supplier_outage`: 주요 공급자 중단
- `document_expiry`: 품질문서 만료
- `inventory_mismatch`: 등록재고와 검증재고 불일치
- `quality_mismatch`: 납품 후 품질 불일치
- `delivery_delay`: 납기 지연
- `settlement_error`: 정산 대사 오류
- `price_spike`: 가격 급등
- `price_drop`: 가격 급락
- `seller_verification_failure`: 공급자 검증 실패

## 현재 구현 규칙

- 구매자 10개, 판매자 20개, 가상 GABA 스펙 1개
- 구매자가 매수가·수량·납기를 제출
- 판매자는 검증된 매물만 체결 가능
- 체결 전 스펙·공급자·문서·품질·재고·납기·가격을 검증
- 검증 실패 매물은 체결되지 않고 차단 이벤트로 기록
- 만료·재고 오류 시나리오는 오류가 발생한 로트·날짜별 차단 이벤트와 해당 로트의 거래 0건을 함께 검증
- 체결 시 재고를 예약·차감
- 납품 후 검수는 계약 스펙과 실제 납품품의 일치 확인
- 정산 오류는 `SETTLEMENT_HOLD`
- 모든 결과는 `SIMULATED` 데이터로 구분

## 중요한 한계

현재 가격은 합성 데이터이며, AI 가격모델이 아니라 설명 가능한 규칙 기반 기준모델이다. 실제 GABA 가격·공급자·품질문서 데이터를 연결할 때는 입력 데이터의 권리·품질·최신성 검증이 선행되어야 한다.
