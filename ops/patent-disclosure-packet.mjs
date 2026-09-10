const prohibitedActions = ['PATENTABILITY_GUARANTEE', 'LEGAL_OPINION', 'EXTERNAL_FILING'];
import { buildPatentClaimOutline } from './patent-claim-outline.mjs';

const summarizeEvidence = (run) => {
  const evidence = Array.isArray(run?.evidence) ? run.evidence : [];
  return {
    total: evidence.length,
    passed: evidence.filter((item) => item.passed).length,
    failed: evidence.filter((item) => !item.passed && !item.skipped).length,
    skipped: evidence.filter((item) => item.skipped).length,
    refs: evidence.map((item) => ({ name: item.name, passed: Boolean(item.passed), skipped: Boolean(item.skipped) })),
  };
};

export const buildPatentDisclosurePacket = ({ traceability, run, generatedAt = run?.generatedAt || new Date().toISOString() } = {}) => {
  if (!traceability?.elements?.length) throw new Error('특허 추적성 구성요소가 필요합니다.');
  const evidenceSummary = summarizeEvidence(run);
  return {
    schemaVersion: 'PATENT-DISCLOSURE-0.1',
    packetId: `PATENT-DISCLOSURE-${run?.runId || 'NO-RUN'}`,
    generatedAt,
    legalStatus: 'INVENTION_DISCLOSURE_ONLY',
    patentabilityGuarantee: false,
    candidateTitle: traceability.candidateTitle,
    technicalTheme: '표준 Material Spec·Lot 증빙 생명주기·체결 직전 원자 예약·불변 스냅샷을 결합한 실물 원료 거래 운영',
    problemStatement: [
      '동일 원료명의 품질·제형·원산지·포장 차이를 거래 전에 정규화한다.',
      '문서 만료·재고 변경·중복 예약을 체결 전에 차단한다.',
      '납품 후 불일치와 체결 당시 증거를 분리해 책임을 재현한다.',
    ],
    candidateMechanisms: traceability.elements.map(({ id, title, technicalMechanism, implementation, tests, humanGate }) => ({
      id, title, technicalMechanism, implementation, tests, humanGate,
    })),
    claimDraftingAid: buildPatentClaimOutline({ traceability }),
    currentImplementationEvidence: evidenceSummary,
    currentRun: run ? { runId: run.runId, decision: run.decision, selectedTaskId: run.selectedTask?.id || null, workPacketId: run.workPacket?.packetId || null } : null,
    externalReviewRequired: traceability.externalReviewRequired,
    prohibitedExternalClaims: traceability.prohibitedExternalClaims,
    prohibitedActions,
    nextProfessionalReview: [
      '공식 선행기술 검색 및 문헌별 차이점 표 작성',
      '변리사의 독립항·종속항 작성 및 진보성 검토',
      '대상 국가별 특허·영업비밀·규제 검토',
    ],
    disclaimer: '본 패킷은 변리사 검토용 발명 설명 자료이며 특허 등록 가능성·법률 의견·외부 출원을 보장하지 않는다.',
  };
};

export const appendPatentDisclosurePacket = async (packetsPath, packet) => {
  const { appendFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  if (!packetsPath) throw new Error('특허 설명 패킷 저장 경로가 필요합니다.');
  await mkdir(dirname(packetsPath), { recursive: true });
  await appendFile(packetsPath, `${JSON.stringify(packet)}\n`, 'utf8');
  return packet;
};

export { prohibitedActions };

