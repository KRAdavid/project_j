const clone = (value) => JSON.parse(JSON.stringify(value));

const elementById = (elements, id) => elements.find((element) => element.id === id) || null;

/**
 * Produce a neutral drafting aid for patent counsel. This is deliberately
 * not a patentability, novelty, infringement, or legal opinion.
 */
export const buildPatentClaimOutline = ({ traceability } = {}) => {
  const elements = Array.isArray(traceability?.elements) ? traceability.elements : [];
  if (!elements.length) throw new Error('청구항 작성 보조에는 발명 구성요소가 필요합니다.');

  const limitationOrder = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'];
  const ordered = limitationOrder.map((id) => elementById(elements, id)).filter(Boolean);
  const remaining = elements.filter((element) => !limitationOrder.includes(element.id));
  const limitations = [...ordered, ...remaining].map((element, index) => ({
    number: index + 1,
    elementId: element.id,
    title: element.title,
    mechanism: element.technicalMechanism,
    implementationEvidence: clone(element.implementation || []),
    testEvidence: clone(element.tests || []),
  }));

  return {
    schemaVersion: 'PATENT-CLAIM-OUTLINE-0.1',
    status: 'ATTORNEY_DRAFT_REQUIRED',
    legalStatus: 'INVENTION_DISCLOSURE_ONLY',
    patentabilityGuarantee: false,
    candidateTitle: traceability.candidateTitle || null,
    independentSystemClaim: {
      preamble: 'A computer-implemented system for executing a physical raw-material trade, comprising:',
      limitations,
      draftingNote: '변리사가 관할권·청구항 형식·선행기술 결과에 따라 삭제·병합·분할·수정해야 한다.',
    },
    dependentClaimCandidates: [
      { candidateId: 'DC-01', dependsOn: ['E1'], focus: '승인된 Material Master 필드 제한', technicalEffect: '동의어·미답변·허용값 외 입력에 의한 스펙 치환을 방지' },
      { candidateId: 'DC-02', dependsOn: ['E2', 'E3'], focus: '증빙 생명주기와 매물 공개 결속', technicalEffect: '검토 전·만료·변조 의심 Lot의 노출을 차단' },
      { candidateId: 'DC-03', dependsOn: ['E3', 'E4'], focus: '수락 순간 재검증과 Lot 원자 예약', technicalEffect: '동시 요청의 초과판매·중복체결을 방지' },
      { candidateId: 'DC-04', dependsOn: ['E4', 'E5'], focus: '멱등 거래명령과 체결 스냅샷', technicalEffect: '네트워크 재시도와 사후 조건 변경에도 체결 상태를 재현' },
      { candidateId: 'DC-05', dependsOn: ['E5', 'E6'], focus: '검수 후 분쟁·격리 분리', technicalEffect: '납품 불일치가 가격 표본과 다른 Lot에 전파되지 않도록 격리' },
      { candidateId: 'DC-06', dependsOn: ['E6', 'E7'], focus: '완료·유효증빙 거래만 가격 표본 편입', technicalEffect: '미완료·분쟁 거래로 가격지표가 왜곡되는 것을 제한' },
    ],
    priorArtReviewWarnings: [
      '자연어 스펙 변환, COA·로트 추적, 구매 매칭, 재고 예약, 해시는 각각 선행기술 범위가 넓으므로 단독 기능을 발명의 중심으로 주장하지 않는다.',
      '청구항에는 입력 데이터 구조, 상태 전이 순서, 재검증 시점, 원자성·멱등성, 공개·격리 결과를 기술적으로 구체화해야 한다.',
      '실제 선행기술 대비 신규성·진보성·침해 여부는 공식 원문과 변리사의 청구항 단위 검토가 필요하다.',
    ],
    evidenceBoundary: {
      requiredBeforeExternalFiling: ['공식 선행기술 조사', '실시예 로그·스키마·테스트 해시 보존', '변리사 청구항 작성', '대상 국가별 법무·규제 검토'],
      prohibitedClaims: ['세계 최초', '특허 등록 보장', '법률 의견'],
    },
  };
};


