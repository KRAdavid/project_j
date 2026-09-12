const state = { role: 'split', material: 'GABA', materialRecord: null, verifiedSpec: { intendedUse: '기능성 식품 원료 개발', purity: '99% 이상', form: '분말', origin: '한국산', pack: '20 kg', deliveryCondition: '상온·밀봉 배송' }, specs: {}, submitted: false, accepted: false, orderId: null, orderPrice: null, tradeId: null, lifecycleStatus: null, orderQuantity: null, backendLot: null, backendLots: [], marketBoard: null, marketBoardStatus: 'LOADING' };
const wizardState = { questions: [], index: 0, selected: '' };
let materialSearchMatch = null;
let materialSearchMatches = [];
let materialSearchSequence = 0;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function getSpecAttributes() {
  return Object.fromEntries(Object.keys(state.verifiedSpec).map((field) => [field, state.specs[field] || '']));
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

const makeIdempotencyKey = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const compactText = (value, limit = 180) => {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
};
const safeTriggerContext = (value) => {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (/(assertionerror|triggeruncaughtexception|node:internal|uncaughtexception|throw\s+new\s+error|file:\/\/\/.*(?:error|throw))/i.test(normalized)) {
    return '자동 검증 오류 증거가 기록되어 재검증과 H-01 검토가 필요합니다.';
  }
  return compactText(normalized || '자동 운영 신호가 기록되었습니다.');
};

async function apiRequest(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '거래 원장 처리에 실패했습니다.');
  return payload;
}

function updateTotal() {
  const price = Number($('#bid-price').value || 0);
  const quantity = Number($('#bid-quantity').value || 0);
  $('#order-total').textContent = `₩${(price * quantity).toLocaleString('ko-KR')}`;
  updateTradeGate();
}

function updateSpecState() {
  const completed = Object.keys(state.verifiedSpec).filter((field) => Boolean(state.specs[field])).length;
  $('#spec-progress').textContent = `${completed} / 6 확정`;
  updateTradeGate();
  syncSplitState();
}

function getSpecReadiness() {
  const fields = Object.keys(state.verifiedSpec);
  const complete = fields.length === 6 && fields.every((field) => Boolean(state.specs[field]));
  const matchesVerifiedLot = complete && fields.every((field) => state.specs[field] === state.verifiedSpec[field]);
  return { complete, matchesVerifiedLot, ready: complete && matchesVerifiedLot };
}

function getVerifiedOffer() {
  return (state.marketBoard?.asks || []).find((offer) => offer.specId === 'GABA-SPEC-001'
    && offer.evidenceStatus === 'PRETRADE_VERIFIED'
    && offer.matchStatus === 'EXACT_SPEC'
    && Number(offer.availableQty) > 0
    && Number(offer.askPrice) > 0) || null;
}

function updateTradeGate() {
  const price = Number($('#bid-price')?.value || 0);
  const quantity = Number($('#bid-quantity')?.value || 0);
  const specReady = state.material === 'GABA' && getSpecReadiness().complete;
  const verifiedLotSpec = state.verifiedSpec;
  const specMatchesVerifiedLot = getSpecReadiness().matchesVerifiedLot;
  const verifiedOffer = getVerifiedOffer();
  const serverReady = ['READY', 'STATE_FALLBACK'].includes(state.marketBoardStatus) && Boolean(verifiedOffer);
  const availableQty = Number(verifiedOffer?.availableQty || 0);
  const quantityReady = serverReady && quantity >= 20 && quantity <= availableQty;
  const ready = !state.submitted && serverReady && specReady && specMatchesVerifiedLot && price >= 1 && quantityReady;
  ['#bid-quantity', '#split-bid-quantity'].forEach((selector) => {
    const input = $(selector);
    if (input) input.max = availableQty > 0 ? String(availableQty) : '';
  });
  const specText = `${state.specs.purity || '순도 미정'} · ${state.specs.form || '제형 미정'} · ${state.specs.origin || '원산지 미정'} · ${state.specs.pack || '포장 미정'}`;
  $('#gate-spec').textContent = specText;
  $('#gate-inventory').textContent = state.accepted
    ? `체결 로트 ${Number(state.orderQuantity || quantity).toLocaleString('ko-KR')} kg 잠금`
    : quantityReady
      ? `${availableQty.toLocaleString('ko-KR')} kg 중 ${quantity.toLocaleString('ko-KR')} kg 가능`
      : `가용재고 ${availableQty.toLocaleString('ko-KR')} kg 확인 필요`;
  $('#gate-status').textContent = state.accepted ? '체결 완료' : state.submitted ? '응답 대기' : ready ? '체결 가능' : '확인 필요';
  $('#trade-gate').classList.toggle('blocked', !ready);
  $('#gate-note').textContent = state.accepted
    ? `${state.tradeId || '체결 건'}가 확정되었습니다. 해당 로트의 재고가 잠금 처리되었습니다.`
    : state.submitted
      ? `${state.orderId || '주문'}가 공급자에게 전달되었습니다. 새 주문은 기존 응답이 끝난 뒤 제출할 수 있습니다.`
      : ready
    ? '검증된 로트와 재고를 확인한 뒤 공급자에게 주문을 전달합니다.'
    : !serverReady
      ? '서버 검증 매물과 가용재고를 확인할 때까지 주문을 제출할 수 없습니다.'
      : quantity > availableQty
        ? `현재 검증 로트의 가용재고(${availableQty.toLocaleString('ko-KR')} kg)보다 큰 수량입니다. 수량을 줄여 주세요.`
      : specReady && !specMatchesVerifiedLot
        ? '현재 검증된 공급 로트와 스펙이 일치하지 않습니다. 일치하는 매물이 등록될 때까지 주문을 제출할 수 없습니다.'
      : '원료·스펙·가격·수량을 모두 확인해야 주문을 제출할 수 있습니다.';
  $('#submit-order').disabled = !ready;
}

function applyBackendSnapshot(snapshot) {
  const lot = snapshot?.lots?.find((candidate) => candidate.lotId === 'GBA-KR-2407');
  const order = snapshot?.orders?.[snapshot.orders.length - 1];
  const trade = snapshot?.trades?.[snapshot.trades.length - 1];
  state.backendLot = lot || null;
  state.backendLots = Array.isArray(snapshot?.lots) ? snapshot.lots : [];
  if (!order) {
    state.submitted = false;
    state.accepted = false;
    state.orderId = null;
    state.tradeId = null;
    state.lifecycleStatus = null;
    renderSellerIncomingOrder(null);
    syncLifecycleUI();
    updateTradeGate();
    return;
  }
  state.orderId = order.orderId;
  state.orderPrice = order.price;
  state.orderQuantity = order.quantity;
  if (order.specAttributes) {
    const orderAttributes = Object.fromEntries(Object.keys(state.verifiedSpec).map((field) => [field, order.specAttributes[field] || '']));
    state.specs = { ...state.specs, ...orderAttributes };
  }
  state.submitted = true;
  state.accepted = ['TRADE_CONFIRMED', 'PARTIALLY_ACCEPTED'].includes(order.status) || ['TRADE_CONFIRMED', 'DELIVERED', 'FULFILLED', 'DISPUTED'].includes(trade?.status);
  state.tradeId = trade?.tradeId || order.tradeId || null;
  state.lifecycleStatus = trade?.status || (state.accepted ? 'TRADE_CONFIRMED' : null);
  renderSellerIncomingOrder(order);
  ['#bid-price', '#split-bid-price'].forEach((selector) => { $(selector).value = order.price; });
  ['#bid-quantity', '#split-bid-quantity'].forEach((selector) => { $(selector).value = order.quantity; });
  if (order.deliveryDate) $('#delivery-date').value = order.deliveryDate;
  $('#order-feedback').className = `order-feedback ${state.accepted ? 'success' : ''}`;
  $('#order-feedback').innerHTML = state.accepted
    ? `주문 <strong>${state.orderId}</strong>가 체결되었습니다. <strong>${state.tradeId}</strong> · 로트 재고 잠금 완료`
    : `주문 <strong>${state.orderId}</strong>가 원장에 기록되었습니다. <strong>공급자 응답을 기다리는 중입니다.</strong>`;
  $('#status-badge').textContent = state.accepted ? '체결 완료' : '공급자 응답 대기';
  $('#status-badge').classList.add('success');
  $('#timeline-order').classList.add('done');
  $('#timeline-order > span').textContent = '✓';
  $('#timeline-order small').textContent = `${order.quantity.toLocaleString('ko-KR')} kg · ₩${order.price.toLocaleString('ko-KR')}/kg 주문 제출 완료`;
  const confirmedStep = $('#timeline-order').nextElementSibling;
  if (state.accepted && confirmedStep) {
    confirmedStep.classList.add('done');
    confirmedStep.querySelector('span').textContent = '✓';
    confirmedStep.querySelector('small').textContent = `${state.tradeId} · 공급자가 주문을 체결했습니다.`;
  }
  syncSplitState();
  updateTotal();
  updateTradeGate();
}

function setTimelineDone(selector, label) {
  const item = $(selector);
  if (!item) return;
  item.classList.add('done');
  item.querySelector('span').textContent = '✓';
  if (label) item.querySelector('small').textContent = label;
}

function syncLifecycleUI() {
  const status = state.lifecycleStatus;
  const statusLabels = { TRADE_CONFIRMED: '체결 완료 · 납품 대기', DELIVERED: '납품 완료 · 검수 대기', FULFILLED: '이행 완료 · 가격지표 반영 가능', DISPUTED: '품질 불일치 · 로트 격리' };
  for (const controls of [
    { panel: '#seller-lifecycle-actions', label: '#lifecycle-status', deliver: '#seller-deliver', pass: '#seller-inspect-pass', fail: '#seller-inspect-fail' },
    { panel: '#split-lifecycle-actions', label: '#split-lifecycle-status', deliver: '#split-seller-deliver', pass: '#split-seller-inspect-pass', fail: '#split-seller-inspect-fail' },
  ]) {
    const panel = $(controls.panel);
    if (!panel) continue;
    panel.hidden = !state.tradeId;
    if (!state.tradeId) continue;
    $(controls.label).textContent = statusLabels[status] || '체결 상태 확인 중';
    $(controls.deliver).disabled = status !== 'TRADE_CONFIRMED';
    $(controls.pass).disabled = !['TRADE_CONFIRMED', 'DELIVERED'].includes(status);
    $(controls.fail).disabled = !['TRADE_CONFIRMED', 'DELIVERED'].includes(status);
  }
  if (!state.tradeId) return;
  setTimelineDone('#timeline-confirm', `${state.tradeId} · 공급자가 주문을 체결했습니다.`);
  if (['DELIVERED', 'FULFILLED', 'DISPUTED'].includes(status)) setTimelineDone('#timeline-delivery', '공급자가 납품을 기록했습니다.');
  if (['FULFILLED', 'DISPUTED'].includes(status)) setTimelineDone('#timeline-inspection', status === 'FULFILLED' ? '검수 통과 · 완료 거래로 기록되었습니다.' : '검수 불일치 · 로트가 격리되었습니다.');
  $('#status-badge').textContent = statusLabels[status] || '체결 완료';
  const primaryInventoryRow = document.querySelector('#seller-view .inventory-row:first-child');
  if (primaryInventoryRow) {
    const remainingQuantity = Number(state.marketBoard?.verifiedInventoryQty || 0);
    const quantityNode = primaryInventoryRow.querySelector('b');
    const statusNode = primaryInventoryRow.querySelector('.row-status');
    if (quantityNode) quantityNode.textContent = `${remainingQuantity.toLocaleString('ko-KR')} kg`;
    if (statusNode) {
      statusNode.classList.toggle('warning', status === 'DISPUTED');
      statusNode.textContent = status === 'DISPUTED'
        ? '격리 · 판매중지'
        : status === 'FULFILLED'
          ? `거래 완료 · ${remainingQuantity.toLocaleString('ko-KR')} kg 잔량`
          : status === 'DELIVERED'
            ? `납품 완료 · ${remainingQuantity.toLocaleString('ko-KR')} kg 잔량`
            : `예약됨 · ${remainingQuantity.toLocaleString('ko-KR')} kg 잔량`;
    }
  }
  $('#status-badge').classList.toggle('success', status !== 'DISPUTED');
}

async function hydrateBackendState() {
  try {
    const snapshot = await apiRequest('/api/state');
    applyBackendSnapshot(snapshot);
  } catch {
    // 정적 미리보기에서는 API가 없을 수 있으므로 화면 시뮬레이션은 계속 표시합니다.
  }
}

async function hydrateMarketBoard() {
  state.marketBoardStatus = 'LOADING';
  renderLiveBook();
  renderVerifiedSupply();
  try {
    state.marketBoard = await apiRequest('/api/market-board?specId=GABA-SPEC-001');
    state.marketBoardStatus = 'READY';
  } catch {
    try {
      const snapshot = await apiRequest('/api/state');
  const asks = (snapshot.lots || [])
        .filter((lot) => lot.specId === 'GABA-SPEC-001'
          && lot.status === 'VERIFIED_ELIGIBLE'
          && lot.evidenceStatus === 'PRETRADE_VERIFIED'
          && Number(lot.availableQty) > 0
          && Number(lot.askPrice) > 0
          && lot.currency === 'KRW'
          && lot.priceUnit === 'KRW_PER_KG'
          && lot.quantityUnit === 'KG')
        .map((lot) => ({
          lotId: lot.lotId,
          supplier: lot.supplier,
          specId: lot.specId,
          availableQty: Number(lot.availableQty),
          askPrice: Number(lot.askPrice),
          currency: lot.currency,
          priceUnit: lot.priceUnit,
          quantityUnit: lot.quantityUnit,
          deliveryDays: Number(lot.deliveryDays),
          evidenceStatus: lot.evidenceStatus,
          matchStatus: 'EXACT_SPEC',
        }))
        .sort((a, b) => a.askPrice - b.askPrice);
      state.marketBoard = { schemaVersion: 'SERVER-STATE-PROJECTION-MARKET-BOARD-0.1', dataStatus: 'SERVER_STATE_PROJECTED_OFFERS', asks, bids: [], recentTrades: [], activityStatus: 'NO_COMPLETED_TRADES', bestAsk: asks[0]?.askPrice || null, verifiedInventoryQty: asks.reduce((total, offer) => total + offer.availableQty, 0) };
      state.marketBoardStatus = 'STATE_FALLBACK';
    } catch {
      state.marketBoard = null;
      state.marketBoardStatus = 'ERROR';
    }
    const note = document.querySelector('.book-note');
    if (note && state.marketBoardStatus === 'ERROR') note.textContent = '서버 확인 필요';
  }
  liveMarket.trades = (state.marketBoard?.recentTrades || []).map((trade) => ({
    time: new Date(trade.fulfilledAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }),
    price: Number(trade.price),
    quantity: Number(trade.quantity),
  }));
  liveMarket.series = liveMarket.trades.map((trade) => trade.price).reverse();
  renderLiveBook();
  renderVerifiedSupply();
  renderSellerInventory();
}

async function hydratePriceIndex() {
  try {
    const index = await apiRequest('/api/price-index?specId=GABA-SPEC-001');
    const published = index.status === 'AVAILABLE' && Number.isFinite(Number(index.value));
    $('#avg-price').innerHTML = published ? `₩${Number(index.value).toLocaleString('ko-KR')} <small>/ kg</small>` : '가격 공개 대기';
    $('#avg-price-trend').textContent = published && index.aiTrend?.changePct !== null ? `${index.aiTrend.direction === 'UPWARD' ? '↗' : index.aiTrend.direction === 'DOWNWARD' ? '↘' : '→'} ${index.aiTrend.changePct}%` : index.sampleSize ? `표본 부족 · ${index.sampleSize}건` : 'AI 승인 필요';
    $('#split-reference-price').innerHTML = published ? `₩${Number(index.value).toLocaleString('ko-KR')} <small>/ kg</small>` : '가격 공개 대기';
    $('#split-reference-trend').textContent = published && index.aiTrend?.changePct !== null ? `${index.aiTrend.direction === 'UPWARD' ? '↗' : index.aiTrend.direction === 'DOWNWARD' ? '↘' : '→'} ${index.aiTrend.changePct}%` : index.sampleSize ? `표본 부족 · ${index.sampleSize}건` : 'AI 승인 필요';
    const liveAverage = $('#live-average-price');
    if (liveAverage) liveAverage.textContent = published ? `₩${Number(index.value).toLocaleString('ko-KR')}` : '가격 공개 대기';
    const liveAverageSample = $('#live-average-sample');
    if (liveAverageSample) liveAverageSample.textContent = published ? `최근 ${index.sampleSize}건 기준` : index.sampleSize ? `완료 거래 ${index.sampleSize}건 · 기준 미달` : '검증된 완료 거래 기준';
    $('#ai-trend-label').textContent = published ? index.aiTrend.label : '공개 승인 대기';
    $('#ai-trend-note').textContent = published ? `${index.aiTrend.disclaimer} 출처·표본·단위가 함께 검증된 결과입니다.` : '검증된 완료 거래 표본과 인간 공개 승인이 확보되면 참고용 가격 추세를 표시합니다.';
    $('#ai-trend-confidence').textContent = published ? `신뢰도 ${index.confidence}%` : '공개 대기';
    renderReferencePriceChart(index.priceSeries || []);
  } catch {
    // 백엔드가 없을 때에도 정적 시뮬레이션 화면은 유지하되, AI 지표는 확정하지 않습니다.
    renderReferencePriceChart([]);
  }
}

function bindSpecControls() {
  $$('[data-spec]').forEach((select) => select.addEventListener('change', (event) => {
    state.specs[event.target.dataset.spec] = event.target.value;
    updateSpecState();
    const label = event.target.closest('label')?.childNodes?.[0]?.textContent?.trim() || event.target.dataset.spec;
    showToast(`${label} 조건을 ${event.target.value}로 확정했습니다.`);
  }));
}

function renderSpecQuestions(record) {
  const container = $('#spec-fields');
  if (!container || !Array.isArray(record?.specQuestionFlow)) return;
  const questions = record.specQuestionFlow.filter((question) => question.required !== false);
  container.innerHTML = questions.map((question) => {
    const field = escapeHtml(question.field);
    const label = escapeHtml(question.label);
    const selected = state.specs[question.field] || '';
    const placeholder = selected ? '' : '<option value="" selected disabled>선택하세요</option>';
    const options = (question.options || []).map((option) => `<option value="${escapeHtml(option)}"${String(option) === String(selected) ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('');
    return `<label>${label} <select data-spec="${field}">${placeholder}${options}</select></label>`;
  }).join('');
  bindSpecControls();
}

async function hydrateMaterialSpec() {
  try {
    const resolved = await apiRequest('/api/materials/resolve?q=GABA');
    if (!resolved.match) return;
    applyMaterialMatch(resolved.match, 'GABA');
    updateSpecState();
    updateTradeGate();
  } catch {
    bindSpecControls();
  }
}

function applyMaterialMatch(match, query = '') {
  if (!match?.materialId) return;
  const changedMaterial = state.material !== match.materialId;
  state.materialRecord = match;
  state.material = match.materialId;
  state.verifiedSpec = Object.fromEntries((match.requiredSpecFields || []).map((field) => [field, match.simulationSpec?.[field] || '']));
  if (changedMaterial) state.specs = {};
  renderSpecQuestions(match);
  const suggestion = $('#search-suggestion');
  const suggestionList = $('#search-suggestion-list');
  materialSearchMatches = [match];
  if (suggestionList) {
    suggestionList.classList.add('hidden');
    suggestionList.innerHTML = '';
  }
  if (suggestion) {
    suggestion.classList.remove('hidden');
    const title = suggestion.querySelector('strong');
    const subtitle = suggestion.querySelector('div span');
    if (title) title.textContent = `${match.materialId} (${match.aliases?.find((alias) => alias !== match.materialId) || '동의어'})`;
    if (subtitle) subtitle.textContent = `${match.canonicalName} · ${match.materialClass === 'RAW_MATERIAL' ? '기능성 원료' : '원료'}`;
  }
  if (query) $('#material-search').value = query;
  updateSpecState();
  updateTradeGate();
}

async function resolveMaterialSearch(query) {
  const sequence = ++materialSearchSequence;
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    materialSearchMatch = null;
    materialSearchMatches = [];
    state.material = '';
    $('#search-suggestion').classList.add('hidden');
    $('#search-suggestion-list').classList.add('hidden');
    updateTradeGate();
    return;
  }
  try {
    const resolved = await apiRequest(`/api/materials/search?q=${encodeURIComponent(normalizedQuery)}&limit=5`);
    if (sequence !== materialSearchSequence) return;
    const matches = Array.isArray(resolved.matches) ? resolved.matches : [];
    materialSearchMatches = matches;
    materialSearchMatch = matches.find((candidate) => candidate.matchType === 'EXACT') || (matches.length === 1 ? matches[0] : null);
    if (!materialSearchMatch) {
      state.material = '';
      $('#search-suggestion').classList.add('hidden');
      const suggestionList = $('#search-suggestion-list');
      if (suggestionList) {
        suggestionList.innerHTML = matches.map((candidate) => `<button type="button" class="search-suggestion" data-material-id="${escapeHtml(candidate.materialId)}"><span class="material-symbol">${escapeHtml(String(candidate.materialId || '?').slice(0, 1))}</span><div><strong>${escapeHtml(candidate.materialId)}${candidate.aliases?.length ? ` (${escapeHtml(candidate.aliases[0])})` : ''}</strong><span>${escapeHtml(candidate.canonicalName || '')} · 후보 선택 후 필수 스펙 확정</span></div><span class="suggestion-arrow">→</span></button>`).join('');
        suggestionList.classList.toggle('hidden', matches.length === 0);
      }
      if (matches.length > 1) showToast('검색 결과에서 정확한 원료를 선택해 주세요.');
      updateTradeGate();
      return;
    }
    applyMaterialMatch(materialSearchMatch);
  } catch (error) {
    if (sequence !== materialSearchSequence) return;
    materialSearchMatch = null;
    materialSearchMatches = [];
    state.material = '';
    $('#search-suggestion').classList.add('hidden');
    $('#search-suggestion-list').classList.add('hidden');
    updateTradeGate();
    showToast(`원료 기준을 확인하지 못했습니다: ${error.message}`);
  }
}

async function hydrateSupplierEligibility() {
  const panel = $('#supplier-eligibility');
  if (!panel) return;
  try {
    const result = await apiRequest('/api/supplier/eligibility');
    const eligible = result.eligibleToSubmitLot === true;
    panel.classList.toggle('eligible', eligible);
    panel.classList.toggle('blocked', !eligible);
    panel.querySelector('.eligibility-icon').textContent = eligible ? '✓' : '!';
    panel.querySelector('strong').textContent = eligible ? '공급자 거래 자격 확인 완료' : '공급자 거래 자격 차단';
    panel.querySelector('small').textContent = eligible
      ? `${result.organizationName || '공급 조직'} · 로트별 COA·SDS·TDS·추적·재고 증빙 필요`
      : (result.reasons || ['운영자 검증이 필요합니다.']).join(' ');
  } catch {
    panel.classList.remove('eligible');
    panel.classList.add('blocked');
    panel.querySelector('.eligibility-icon').textContent = '!';
    panel.querySelector('strong').textContent = '공급자 거래 자격 확인 실패';
    panel.querySelector('small').textContent = '확인 실패 시 신규 매물 등록과 체결을 진행할 수 없습니다.';
  }
}

async function requestSupplierVerification(event) {
  event.preventDefault();
  const button = $('#request-supplier-verification');
  button.disabled = true;
  try {
    const result = await apiRequest('/api/supplier/verification-request', {
      method: 'POST',
      body: JSON.stringify({
        businessRegistrationRef: $('#business-registration-ref').value.trim(),
        evidenceRefs: {
          businessRegistration: $('#business-registration-ref').value.trim(),
          supplierIdentity: $('#supplier-identity-ref').value.trim(),
        },
        idempotencyKey: makeIdempotencyKey('supplier-verification'),
      }),
    });
    $('#supplier-verification-form').classList.add('hidden');
    await hydrateSupplierEligibility();
    showToast(result.status === 'ALREADY_VERIFIED' ? '이미 검증된 공급자 조직입니다.' : `검증 요청 ${result.request?.requestId || ''} 접수 · H-01 검토 대기`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function renderWizardQuestion() {
  const question = wizardState.questions[wizardState.index];
  if (!question) return;
  $('#wizard-progress').textContent = `${wizardState.index + 1} / ${wizardState.questions.length}`;
  $('#wizard-title').textContent = question.label;
  $('#wizard-help').textContent = wizardState.index === 0 ? '정확한 공급조건을 찾기 위해 한 가지만 확인할게요. 모르는 항목은 전문가 확인이 필요합니다.' : '현재 원료 조건에 맞는 선택지만 표시합니다. 선택한 값은 거래 조건에 포함됩니다.';
  $('#wizard-options').innerHTML = question.options.map((option) => `<button type="button" class="wizard-option${option === wizardState.selected ? ' selected' : ''}" data-wizard-value="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('');
  $('#wizard-back').disabled = wizardState.index === 0;
  $('#wizard-next').disabled = !wizardState.selected;
  $('#wizard-next').innerHTML = wizardState.index === wizardState.questions.length - 1 ? '스펙 확정 <span>✓</span>' : '다음 질문 <span>→</span>';
  $$('.wizard-option').forEach((button) => button.addEventListener('click', () => {
    wizardState.selected = button.dataset.wizardValue;
    $$('.wizard-option').forEach((candidate) => candidate.classList.toggle('selected', candidate === button));
    $('#wizard-next').disabled = false;
  }));
}

function closeSpecWizard() {
  $('#spec-wizard').classList.add('hidden');
}

function openSpecWizard() {
  if (!state.materialRecord?.specQuestionFlow?.length) return showToast('원료 기준을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.');
  wizardState.questions = state.materialRecord.specQuestionFlow.filter((question) => question.required !== false);
  const firstMissing = wizardState.questions.findIndex((question) => !state.specs[question.field]);
  wizardState.index = firstMissing >= 0 ? firstMissing : 0;
  wizardState.selected = state.specs[wizardState.questions[wizardState.index].field] || '';
  $('#spec-wizard').classList.remove('hidden');
  renderWizardQuestion();
}

function advanceSpecWizard() {
  const question = wizardState.questions[wizardState.index];
  if (!question || !wizardState.selected) return;
  state.specs[question.field] = wizardState.selected;
  updateSpecState();
  renderSpecQuestions(state.materialRecord);
  if (wizardState.index === wizardState.questions.length - 1) {
    closeSpecWizard();
    showToast(getSpecReadiness().ready ? '6개 스펙이 확정되었습니다. 검증 매물과 가격을 확인해 주세요.' : '스펙은 확정되었지만 현재 검증된 공급 로트와 일치하지 않습니다.');
    return;
  }
  wizardState.index += 1;
  const next = wizardState.questions[wizardState.index];
  wizardState.selected = state.specs[next.field] || '';
  renderWizardQuestion();
}

function rewindSpecWizard() {
  if (wizardState.index === 0) return;
  wizardState.index -= 1;
  const question = wizardState.questions[wizardState.index];
  wizardState.selected = state.specs[question.field] || '';
  renderWizardQuestion();
}

async function hydrateOpsSummary() {
  try {
    const summary = await apiRequest('/api/ops/summary');
    $('#ops-service-status').textContent = '정상 응답';
    $('#ops-data-status').textContent = summary.dataStatus === 'LIVE_POSTGRESQL_LEDGER' ? 'PostgreSQL 상용 원장' : '시뮬레이션 백엔드';
    const readiness = summary.readiness || {};
    const readinessMissing = readiness.missing || [];
    $('#ops-readiness-status').textContent = readiness.decision || '확인 불가';
    $('#ops-readiness-missing').textContent = readinessMissing.length ? `미충족 ${readinessMissing.length}개 · ${readinessMissing.join('/')}` : '필수조건 충족';
    const readinessChecks = readiness.checks || [];
    const readinessDiagnostics = readiness.diagnostics || [];
    const readinessDetailList = $('#ops-readiness-detail-list');
    if (readinessDetailList) {
      $('#ops-readiness-detail-state').textContent = readinessMissing.length ? `${readinessMissing.length}개 보류` : '전환 가능';
      $('#ops-readiness-detail-state').classList.toggle('success', readinessMissing.length === 0);
      readinessDetailList.innerHTML = readinessMissing.length ? readinessMissing.map((gateId) => {
        const check = readinessChecks.find((item) => item.id === gateId) || {};
        const diagnostic = readinessDiagnostics.find((item) => item.id === gateId) || {};
        const missing = Array.isArray(diagnostic.missing) && diagnostic.missing.length ? diagnostic.missing.join(' · ') : '세부 결손 항목 확인 필요';
        return `<div class="ops-readiness-row"><div class="readiness-gate-id">${escapeHtml(gateId)}</div><div><strong>${escapeHtml(check.name || '필수 전환 게이트')}</strong><small>${escapeHtml(check.evidence || '증거 위치 확인 필요')}</small></div><div><b>확인 필요</b><small>${escapeHtml(missing)}</small></div></div>`;
      }).join('') : '<div class="ops-empty">모든 필수 전환 조건이 충족되었습니다.</div>';
    }
    $('#ops-approval-count').textContent = summary.approvalInbox?.status === 'PENDING' ? `${summary.approvalInbox.pending}건` : summary.approvalInbox?.status === 'CLEAR' ? '0건' : '확인 필요';
    $('#ops-critical-count').textContent = `${summary.queue?.criticalOpen || 0}건`;
    const taskSla = summary.taskSla || {};
    const taskSlaHealthy = taskSla.status === 'WITHIN_SLA';
    $('#ops-task-sla-status').textContent = taskSla.status === 'STALE_TASKS' ? `${taskSla.staleCount || 0}건 초과` : taskSla.status === 'WITHIN_SLA' ? '정상' : '확인 필요';
    $('#ops-task-sla-status').classList.toggle('success', taskSlaHealthy);
    $('#ops-task-sla-detail').textContent = taskSla.status === 'STALE_TASKS' ? 'AI-01·H-01 상향보고 생성' : taskSla.activeCount != null ? `${taskSla.activeCount}건 활성 업무 감시 중` : 'SLA 상태 미연결';
    const daemon = summary.daemonStatus || {};
    const daemonLabels = { RUNNING: '대기 중', CYCLE_RUNNING: '사이클 실행 중', WAITING: '대기 중', TIMEOUT: '타임아웃·검토', STOPPING: '종료 중', NOT_REPORTED: '미보고' };
    const daemonNeedsReview = Number(daemon.lastCycleExitCode || 0) !== 0;
    const daemonHealthy = ['RUNNING', 'CYCLE_RUNNING', 'WAITING'].includes(daemon.status) && !daemonNeedsReview;
    $('#ops-daemon-status').textContent = daemonNeedsReview ? 'H-01 검토' : daemonLabels[daemon.status] || '확인 필요';
    $('#ops-daemon-status').classList.toggle('success', daemonHealthy);
    $('#ops-daemon-detail').textContent = daemon.lastCycle ? `사이클 ${daemon.lastCycle} · ${daemon.lastCycleTimedOut ? '시간 초과' : daemonNeedsReview ? `H-01 검토 필요${daemon.lastCycleDecision ? ` · ${daemon.lastCycleDecision}` : ''}` : '정상 종료'}` : daemon.status === 'NOT_REPORTED' ? '데몬 상태 원장 미연결' : '첫 사이클 실행 중';
    const taskAudit = summary.taskTimelineAudit || {};
    const taskAuditHealthy = taskAudit.status === 'VALID' || taskAudit.status === 'CORRECTED_ARCHIVE_TIMELINE';
    $('#ops-task-audit-status').textContent = taskAudit.status === 'ACTIVE_TIMELINE_INVALID' ? `${taskAudit.activeViolationCount || 0}건 사고` : taskAudit.status === 'CORRECTED_ARCHIVE_TIMELINE' ? '정정 완료' : taskAudit.status === 'VALID' ? '정상' : '확인 필요';
    $('#ops-task-audit-status').classList.toggle('success', taskAuditHealthy);
    $('#ops-task-audit-detail').textContent = taskAudit.status === 'ACTIVE_TIMELINE_INVALID' ? 'H-01 검토 전 자동 수정 금지' : taskAudit.correctedCount ? `아카이브 ${taskAudit.correctedCount}건 정정 기록` : taskAudit.status === 'VALID' ? '생명주기 순서 이상 없음' : '최신 사이클 감사 미연결';
    const supervisor = summary.supervisorStatus || { status: 'NOT_REPORTED', serverRestarts: 0, daemonRestarts: 0 };
    const supervisorHealthy = supervisor.status === 'RUNNING';
    $('#ops-supervisor-status').textContent = supervisorHealthy ? '정상 감시' : supervisor.status === 'DEGRADED' ? '저하' : supervisor.status === 'HALTED_REQUIRES_H01' ? 'H-01 중단' : '미연결';
    $('#ops-supervisor-status').classList.toggle('success', supervisorHealthy);
    $('#ops-supervisor-detail').textContent = supervisorHealthy ? `재시작 ${Number(supervisor.serverRestarts || 0) + Number(supervisor.daemonRestarts || 0)}회 · 자동복구 감시 중` : supervisor.lastError || '감독자 상태 파일이 없습니다.';
    const notificationOutbox = summary.notificationOutbox || { status: 'UNAVAILABLE', pending: null, items: [] };
    const notificationPending = Number(notificationOutbox.pending || 0);
    $('#ops-notification-count').textContent = notificationOutbox.status === 'INVALID' ? '오류' : notificationOutbox.status === 'UNAVAILABLE' ? '미연결' : `${notificationPending}건`;
    const notificationDelivery = notificationOutbox.delivery || 'OUTBOX_ONLY';
    const deliveryDetail = notificationDelivery === 'DELIVERED' ? '승인된 외부 채널 전송 기록' : notificationDelivery === 'DELIVERY_FAILED' || notificationDelivery === 'PARTIAL_FAILURE' ? '외부 전송 실패 · H-01 검토 필요' : '대기함 기록 · 외부 발송 없음';
    $('#ops-notification-detail').textContent = notificationOutbox.status === 'INVALID' ? '대기함 파싱 실패 · 거래 중지' : notificationOutbox.status === 'UNAVAILABLE' ? '최신 운영 API 재기동 필요' : deliveryDetail;
    $('#ops-notification-state').textContent = notificationOutbox.status === 'PENDING' ? '검토 필요' : notificationOutbox.status === 'CLEAR' ? '대기 없음' : notificationOutbox.status === 'UNAVAILABLE' ? '미연결' : '확인 필요';
    $('#ops-notification-state').classList.toggle('success', notificationOutbox.status === 'CLEAR');
    const notifications = notificationOutbox.items || [];
    const severityLabels = { CRITICAL: '중대', HIGH: '높음', MEDIUM: '보통' };
    $('#ops-notification-list').innerHTML = notifications.length ? notifications.map((item) => {
      const pending = item.state === 'PENDING';
      const action = pending
        ? `<button class="notification-ack-button" data-notification-ack="${escapeHtml(item.notificationId || item.fingerprint || '')}">운영자 확인</button>`
        : `<em class="notification-acknowledged">${escapeHtml(item.acknowledgedBy || '운영자')} 확인 · ${escapeHtml(item.acknowledgedAt || '')}</em>`;
      return `<div class="ops-notification-row"><div><strong>${escapeHtml(item.notificationType || 'OPS_NOTIFICATION')}</strong><span>${escapeHtml(item.title || '')}</span><small>${escapeHtml(item.message || '')}</small></div><b>${escapeHtml(severityLabels[item.severity] || item.severity || '확인')}</b><div class="notification-actions">${action}</div></div>`;
    }).join('') : `<div class="ops-empty">${notificationOutbox.status === 'UNAVAILABLE' ? '운영 알림 API가 연결되지 않았습니다. 최신 서버 재기동 후 표시됩니다.' : notificationOutbox.status === 'INVALID' ? '운영 알림 대기함을 읽지 못했습니다. 신규 거래를 중지하고 확인하세요.' : '현재 기록된 운영 알림이 없습니다.'}</div>`;
    $$('[data-notification-ack]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await apiRequest(`/api/ops/notifications/${encodeURIComponent(button.dataset.notificationAck)}/ack`, { method: 'POST', headers: { 'x-demo-role': 'OPERATOR', 'x-raw-user-id': 'SIM-OPERATOR-001' }, body: JSON.stringify({}) });
        showToast(result.idempotent ? '이미 확인된 운영 알림입니다.' : '운영 알림 수신 사실을 기록했습니다.');
        await hydrateOpsSummary();
      } catch (error) {
        button.disabled = false;
        showToast(error.message);
      }
    }));
    const triggerInbox = summary.triggerInbox || {};
    $('#ops-trigger-count').textContent = `${triggerInbox.pending || 0}건`;
    $('#ops-trigger-state').textContent = triggerInbox.status === 'PENDING' ? '자동 생성·승인 대기' : triggerInbox.status === 'CLEAR' ? '대기 없음' : '활성 신호 없음 · 이력 보존';
    $('#ops-trigger-inbox-state').textContent = triggerInbox.status === 'PENDING' ? '검토 필요' : triggerInbox.status === 'CLEAR' ? '대기 없음' : '이력만 보존';
    $('#ops-trigger-inbox-state').classList.toggle('success', triggerInbox.status === 'CLEAR');
    const triggerTasks = triggerInbox.tasks || [];
    $('#ops-trigger-list').innerHTML = triggerTasks.length ? triggerTasks.slice(-5).reverse().map((task) => {
      const activeSignal = task.lastRecheckResult !== 'NOT_DETECTED';
      const recheck = activeSignal ? '<small>현재 신호 감지 · 자동 실행 보류</small>' : '<small>최근 재검증에서 재현되지 않음 · H-01 종결 필요</small>';
      const triggerContext = safeTriggerContext(compactText(task.whyNow || '자동 운영 신호가 기록되었습니다.'));
      const triggerBadge = activeSignal ? '현재 감지' : '재검증 종료 대기';
      return `<div class="ops-trigger-row"><div><strong>${escapeHtml(task.triggerKey || 'AUTO_TRIGGER')}</strong><span>${escapeHtml(task.objective || '')}</span><small>${escapeHtml(triggerContext)}</small>${recheck}</div><div><small>담당 ${escapeHtml(task.ownerAi || '미지정')} · 검토 ${escapeHtml((task.reviewers || []).join(', '))}</small></div><span class="trigger-badge">${triggerBadge}</span></div>`;
    }).join('') : '<div class="ops-empty">자동 생성된 운영 업무가 없습니다.</div>';
    const inboxState = summary.approvalInbox?.status;
    $('#ops-inbox-state').textContent = inboxState === 'PENDING' ? '결정 필요' : inboxState === 'CLEAR' ? '대기 없음' : '운영 확인 필요';
    $('#ops-inbox-state').classList.toggle('success', inboxState === 'CLEAR');
    const approvals = summary.approvalInbox?.items || [];
    const approvalGuides = summary.approvalDecisionGuide || [];
    const decisionLabels = { APPROVED: '승인 완료', CHANGES_REQUESTED: '수정요청 완료', HELD: '보류 중', REJECTED: '거절 완료' };
    $('#ops-approval-list').innerHTML = approvals.length ? approvals.map((item) => {
      const pending = item.status === 'PENDING';
      const decision = decisionLabels[item.status] || '결정 기록';
      const guide = approvalGuides.find((candidate) => candidate.approvalId === item.approvalId);
      const guideLabel = guide?.recommendation === 'APPROVE_AI_REMEDIATION_ONLY' ? 'AI 정정만 승인' : '실거래 보류';
      const guideMarkup = guide ? `<small class="approval-guidance">권고: ${escapeHtml(guideLabel)} · 외부 실행 없음</small>` : '';
      const actionMarkup = pending
        ? `<span class="approval-wait">H-01 결정 대기</span><div><button class="approval-button" data-approval-action="approve" data-approval-id="${escapeHtml(item.approvalId)}">승인</button><button class="approval-button" data-approval-action="request_changes" data-approval-id="${escapeHtml(item.approvalId)}">수정요청</button><button class="approval-button" data-approval-action="hold" data-approval-id="${escapeHtml(item.approvalId)}">보류</button><button class="approval-button danger" data-approval-action="reject" data-approval-id="${escapeHtml(item.approvalId)}">거절</button></div>`
        : `<span class="approval-decision">${escapeHtml(decision)}</span><small>${escapeHtml(item.decisionNote || '')}</small>`;
      return `<div class="ops-approval-row"><div><strong>${escapeHtml(item.taskId)}</strong><span>${escapeHtml(item.objective)}</span>${guideMarkup}</div><div><b>${escapeHtml(String(item.risk || '').toUpperCase())}</b><small>검토자 ${escapeHtml((item.reviewers || []).join(', '))}</small></div><div class="approval-actions">${actionMarkup}</div></div>`;
    }).join('') : '<div class="ops-empty">현재 인간 승인 대기 업무가 없습니다.</div>';
    $$('.approval-button').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await apiRequest(`/api/ops/approvals/${encodeURIComponent(button.dataset.approvalId)}`, { method: 'POST', headers: { 'x-demo-role': 'OWNER', 'x-raw-user-id': 'H-01' }, body: JSON.stringify({ decision: button.dataset.approvalAction }) });
        showToast(`${result.approval.status} 처리되었습니다. 실제 거래·결제는 실행되지 않습니다.`);
        await hydrateOpsSummary();
      } catch (error) {
        button.disabled = false;
        showToast(error.message);
      }
    }));
    const supplierVerification = summary.supplierVerification || {};
    const supplierRequests = supplierVerification.items || [];
    const supplierReviewState = supplierRequests.some((item) => item.status === 'UNDER_REVIEW') ? '최종 검토 필요' : supplierRequests.some((item) => item.status === 'REQUESTED') ? '진행 승인 대기' : '대기 없음';
    $('#ops-supplier-review-state').textContent = supplierReviewState;
    $('#ops-supplier-review-state').classList.toggle('success', supplierReviewState === '대기 없음');
    const supplierStatusLabels = { REQUESTED: 'H-01 진행 승인 대기', UNDER_REVIEW: '최종 인간 검토 필요', APPROVED: '검증 완료', REJECTED: '검증 거절' };
    $('#ops-supplier-review-list').innerHTML = supplierRequests.length ? supplierRequests.map((item) => `<div class="ops-supplier-review-row"><div><strong>${escapeHtml(item.organizationName || item.organizationId || '공급 조직')}</strong><span>${escapeHtml(item.requestId || '')}</span></div><div><b>${escapeHtml(supplierStatusLabels[item.status] || item.status || '상태 확인')}</b><small>H-01 승인: ${escapeHtml(item.approvalStatus || '확인 중')}</small></div><div><small>요청 ${escapeHtml(item.requestedAt || '')}</small><small>${item.status === 'UNDER_REVIEW' ? '증빙 원문·사업자 정보를 인간이 확인해야 합니다.' : 'AI는 자격을 승인하지 않습니다.'}</small></div></div>`).join('') : '<div class="ops-empty">현재 공급자 검증 요청이 없습니다.</div>';
    const teamRoster = summary.teamRoster || {};
    const teamMembers = teamRoster.members || [];
    $('#ops-team-state').textContent = teamMembers.length ? `${teamMembers.length}명 운영 중` : '명부 확인 필요';
    $('#ops-team-state').classList.toggle('success', teamMembers.length === 14 && teamRoster.humanApprovalPrincipal === 'H-01');
    const taskOwnership = summary.taskOwnership || {};
    const taskOwnershipValid = taskOwnership.status === 'VALID';
    $('#ops-team-ownership-state').textContent = taskOwnershipValid
      ? `업무 소유권 정상 · ${taskOwnership.valid || 0}/${taskOwnership.total || 0}건 · H-01 승인 게이트 적용`
      : `업무 소유권 확인 필요 · ${taskOwnership.errors?.[0] || '담당·검토자 연결 오류'}`;
    $('#ops-team-ownership-state').classList.toggle('success', taskOwnershipValid);
    const autonomyLabels = { FINAL_DECISION: '최종 결정권', ANALYZE_PREPARE: '분석·준비 자동' };
    $('#ops-team-list').innerHTML = teamMembers.length ? teamMembers.map((member) => `<div class="ops-team-row"><span class="team-kind ${member.kind === 'HUMAN' ? 'human' : 'ai'}">${escapeHtml(member.id)}</span><div><strong>${escapeHtml(member.name || '')}</strong><small>${escapeHtml(member.role || '')}</small></div><b>${escapeHtml(autonomyLabels[member.autonomy] || '권한 확인')}</b></div>`).join('') : '<div class="ops-empty">참여 팀 명부를 확인할 수 없습니다.</div>';

     const teamActivity = summary.teamActivity || {};
     const activityCounts = teamActivity.counts || {};
     const executionSummary = teamActivity.executionSummary || {};
     const activityStatusLabels = { AUTO_EXECUTING: '자동 준비 실행', AUTO_QUEUE_ACTIVE: '자동 큐 대기', WAITING_FOR_H01: 'H-01 승인 대기', UNVERIFIED_ACTIVE: '실행 증거 확인 필요', READY_FOR_DECISION: '대표 결정 가능', IDLE: '대기' };
     const autoExecuting = Number(activityCounts.AUTO_EXECUTING || 0);
     const waitingForH01 = Number(activityCounts.WAITING_FOR_H01 || 0);
     const unverifiedActive = Number(activityCounts.UNVERIFIED_ACTIVE || 0);
     $('#ops-team-activity-state').textContent = autoExecuting ? `${autoExecuting}명 준비 실행` : waitingForH01 ? '승인 대기 중' : '자동 큐 확인';
     $('#ops-team-activity-summary').textContent = `자동 준비 ${autoExecuting}명 · 승인 대기 ${waitingForH01}명 · 증거 확인 필요 ${unverifiedActive}명 · H-01 결정 대기 ${executionSummary.pendingApprovalCount || 0}건${executionSummary.independentPreparationContinuesWhileApprovalPending ? ' · 승인 대기 중에도 독립 준비 계속' : ''}`;
     const activityMembers = teamActivity.members || [];
     $('#ops-team-activity-list').innerHTML = activityMembers.length ? activityMembers.map((member) => `<div class="ops-team-activity-row"><div><strong>${escapeHtml(member.memberId || '')}</strong><small>${escapeHtml(member.name || '')}</small></div><b class="activity-status ${member.status === 'UNVERIFIED_ACTIVE' ? 'warning' : member.status === 'WAITING_FOR_H01' ? 'waiting' : ''}">${escapeHtml(activityStatusLabels[member.status] || member.status || '상태 확인')}</b><span>${escapeHtml(member.reason || '')}</span></div>`).join('') : '<div class="ops-empty">현재 팀 활동 상태가 없습니다.</div>';
    const latest = summary.latestRun;
    $('#ops-run-decision').textContent = latest?.decision || '실행 기록 없음';
    $('#ops-run-decision').classList.toggle('success', latest?.decision === 'GO');
    $('#ops-run-id').textContent = latest?.runId || '—';
    $('#ops-run-task').textContent = latest?.selectedTask ? `${latest.selectedTask} · ${latest.selectedOwner || '담당 확인'}` : '—';
    $('#ops-run-packet').textContent = latest?.workPacketId ? `${latest.workPacketStatus || '생성'} · ${latest.workPacketId}` : '—';
    $('#ops-run-patent').textContent = latest?.patentPacketId ? `${latest.patentPacketStatus || '검토 전용'} · ${latest.patentPacketId}` : '—';
    $('#ops-run-skipped').textContent = latest?.skippedEvidence?.length ? latest.skippedEvidence.join(', ') : '없음';
  } catch (error) {
    $('#ops-service-status').textContent = '확인 실패';
    $('#ops-data-status').textContent = error.message;
    $('#ops-readiness-status').textContent = 'NO-GO';
    $('#ops-inbox-state').textContent = '운영 확인 필요';
    $('#ops-inbox-state').classList.remove('success');
  }
}

const liveMarket = {
  price: null,
  tick: 0,
  series: [],
  trades: [],
  events: [],
};
let realtimePaused = false;

function renderReferencePriceChart(series = []) {
  const line = $('#reference-chart-line');
  const area = $('#reference-chart-area');
  const dot = $('#reference-chart-dot');
  const empty = $('#reference-chart-empty');
  if (!line || !area || !dot) return;
  const prices = (Array.isArray(series) ? series : [])
    .map((item) => Number(item?.price))
    .filter((price) => Number.isFinite(price) && price > 0);
  if (!prices.length) {
    line.setAttribute('d', 'M0 112 L640 112');
    area.setAttribute('d', 'M0 112 L640 112 L640 150 L0 150Z');
    dot.setAttribute('visibility', 'hidden');
    if (empty) empty.setAttribute('visibility', 'visible');
    return;
  }
  const min = Math.min(...prices) - 30;
  const max = Math.max(...prices) + 30;
  const span = Math.max(1, max - min);
  const points = prices.map((price, index) => {
    const x = prices.length === 1 ? 320 : (index / (prices.length - 1)) * 640;
    const y = 120 - ((price - min) / span) * 84;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });
  const path = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
  line.setAttribute('d', path);
  area.setAttribute('d', `${path} L640 150 L0 150Z`);
  const [lastX, lastY] = points[points.length - 1];
  dot.setAttribute('cx', lastX);
  dot.setAttribute('cy', lastY);
  dot.setAttribute('visibility', 'visible');
  if (empty) empty.setAttribute('visibility', 'hidden');
}

function connectLedgerStream() {
  if (!window.EventSource) return;
  const source = new EventSource('/api/events');
  source.addEventListener('ledger', (event) => {
    try {
      const payload = JSON.parse(event.data);
      const ledgerEvent = payload.event;
      if (!ledgerEvent) return;
      const time = new Date(ledgerEvent.occurredAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      liveMarket.events.unshift({ time, text: ledgerEvent.message });
      liveMarket.events = liveMarket.events.slice(0, 3);
      void hydrateMarketBoard();
      void hydratePriceIndex();
      renderLiveTape();
    } catch {
      // 잘못된 이벤트는 화면 시뮬레이션을 중단시키지 않습니다.
    }
  });
}

function renderLiveBook() {
  const asks = state.marketBoard?.asks || [];
  const row = (item) => `<div class="book-row"><div><strong>${escapeHtml(item.supplier)}</strong><span>${escapeHtml(item.lotId)}</span></div><b>${Number(item.availableQty).toLocaleString('ko-KR')} kg</b><span class="book-price">₩${Number(item.askPrice).toLocaleString('ko-KR')}</span></div>`;
  $('#ask-book').innerHTML = state.marketBoardStatus === 'LOADING'
    ? '<div class="book-empty">서버 검증 매물 확인 중…</div>'
    : state.marketBoardStatus === 'ERROR'
      ? '<div class="book-empty">서버 매물 확인 실패 · 노출 보류</div>'
      : asks.length ? asks.map(row).join('') : '<div class="book-empty">현재 검증 완료 매물 없음</div>';
  $('#bid-book').innerHTML = '<div class="book-empty">공개 매수 호가 없음</div>';
  const note = document.querySelector('.book-note');
  if (note) note.textContent = ['READY', 'STATE_FALLBACK'].includes(state.marketBoardStatus) ? `검증 매물 ${asks.length}개` : state.marketBoardStatus === 'LOADING' ? '서버 확인 중' : '서버 확인 필요';
  const bestAsk = Number(state.marketBoard?.bestAsk);
  $('#book-mid-price').textContent = Number.isFinite(bestAsk) && bestAsk > 0 ? `₩${bestAsk.toLocaleString('ko-KR')}` : '가격 대기';
  const splitStock = $('#split-verified-stock');
  const splitStockStatus = $('#split-verified-stock-status');
  if (splitStock && splitStockStatus) {
    const inventoryKnown = ['READY', 'STATE_FALLBACK'].includes(state.marketBoardStatus);
    const inventoryQty = Number(state.marketBoard?.verifiedInventoryQty || 0);
    splitStock.textContent = inventoryKnown ? `${inventoryQty.toLocaleString('ko-KR')} kg` : '확인 중';
    splitStockStatus.textContent = inventoryKnown && inventoryQty > 0 ? '주문 가능' : inventoryKnown ? '검증 재고 없음' : '서버 확인 필요';
  }
  updateTradeGate();
}

function renderVerifiedSupply() {
  const list = $('#supply-list');
  const count = $('#supply-count');
  if (!list) return;
  const asks = state.marketBoard?.asks || [];
  if (count) count.textContent = state.marketBoardStatus === 'READY' ? `${asks.length}개 매물` : '확인 중';
  if (state.marketBoardStatus === 'LOADING') {
    list.innerHTML = '<div class="supply-empty">서버 원장에서 검증된 매물을 확인하는 중입니다.</div>';
    return;
  }
  if (!['READY', 'STATE_FALLBACK'].includes(state.marketBoardStatus)) {
    list.innerHTML = '<div class="supply-empty">검증 상태를 확인할 수 없어 매물 노출을 보류합니다.</div>';
    return;
  }
  if (!asks.length) {
    list.innerHTML = '<div class="supply-empty">현재 확정 스펙과 일치하는 검증 매물이 없습니다.</div>';
    return;
  }
  list.innerHTML = asks.map((offer, index) => `<article class="supply-card${index === 0 ? ' featured' : ''}"><div class="supply-card-top"><div><strong>GABA 기준 스펙</strong><span>로트 ${escapeHtml(offer.lotId)} · 정확 일치</span></div><span class="match-rate">100% 일치</span></div><div class="supply-meta"><div><span>검증 재고</span><b>${Number(offer.availableQty).toLocaleString('ko-KR')} kg</b></div><div><span>공급자</span><b>${escapeHtml(offer.supplier)}</b></div><div><span>납품 예정</span><b>${Number(offer.deliveryDays)}일 이내</b></div></div><div class="supply-bottom"><span class="doc-ok">✓ 거래 전 증빙 유효</span><span class="supply-price">₩${Number(offer.askPrice).toLocaleString('ko-KR')}<small>/ kg</small></span></div></article>`).join('');
}

function renderSellerInventory() {
  const list = $('#seller-inventory-list');
  const count = $('#seller-verified-count');
  if (!list) return;
  const lots = (state.marketBoard?.asks || []).filter((offer) => offer.evidenceStatus === 'PRETRADE_VERIFIED' && Number(offer.availableQty) > 0);
  if (count) count.textContent = ['READY', 'STATE_FALLBACK'].includes(state.marketBoardStatus) ? `${lots.length}건 서버 검증됨` : '확인 중';
  if (state.marketBoardStatus === 'LOADING') {
    list.innerHTML = '<div class="supply-empty">서버 원장에서 검증 재고를 확인하는 중입니다.</div>';
    return;
  }
  if (!['READY', 'STATE_FALLBACK'].includes(state.marketBoardStatus) || !lots.length) {
    list.innerHTML = '<div class="supply-empty">거래 가능한 서버 검증 재고가 없습니다.</div>';
    return;
  }
  list.innerHTML = lots.map((lot) => `<div class="inventory-row"><div><strong>GABA 기준 스펙</strong><span>${escapeHtml(lot.lotId)} · ${escapeHtml(lot.supplier)}</span></div><b>${Number(lot.availableQty).toLocaleString('ko-KR')} kg</b><span class="row-status">주문 가능</span></div>`).join('');
}

function renderSellerIncomingOrder(order) {
  const summary = document.querySelector('.seller-order-summary');
  const button = $('#seller-accept');
  if (!summary || !button) return;
  const materialNode = $('#seller-order-material');
  const quantityNode = $('#seller-order-quantity');
  const priceNode = $('#seller-order-price');
  const deadlineNode = $('#seller-order-deadline');
  if (!order) {
    if (materialNode) materialNode.textContent = '현재 수신된 구매 주문 없음';
    if (quantityNode) quantityNode.textContent = '주문이 제출되면 수량이 표시됩니다.';
    if (priceNode) priceNode.textContent = '가격 대기';
    if (deadlineNode) deadlineNode.textContent = '주문이 제출되면 희망 납기가 표시됩니다.';
    button.disabled = true;
    return;
  }
  if (materialNode) materialNode.textContent = `GABA 기준 스펙 · ${Number(order.quantity || 0).toLocaleString('ko-KR')} kg · ${escapeHtml(order.orderId || '')}`;
  if (quantityNode) quantityNode.textContent = `${Number(order.quantity || 0).toLocaleString('ko-KR')} kg 주문`;
  if (priceNode) priceNode.textContent = `₩${Number(order.price || 0).toLocaleString('ko-KR')}/kg`;
  if (deadlineNode) deadlineNode.textContent = `희망 납기 ${escapeHtml(order.deliveryDate || '확인 필요')}`;
  button.disabled = Boolean(state.accepted);
}

function renderLiveTape() {
  $('#trade-tape').innerHTML = liveMarket.trades.length
    ? liveMarket.trades.map((trade, index) => `<div class="trade-row ${index === 0 ? 'new' : ''}"><span>${trade.time}</span><strong>₩${trade.price.toLocaleString('ko-KR')}</strong><span>${trade.quantity.toLocaleString('ko-KR')} kg</span></div>`).join('')
    : '<div class="book-empty">완료된 실물 체결 데이터 없음</div>';
  $('#event-log').innerHTML = liveMarket.events.map((event) => `<div class="event-row"><time>${event.time}</time><span>${event.text}</span></div>`).join('');
}

function renderLiveChart() {
  const chartEmpty = $('#live-chart-empty');
  if (!liveMarket.series.length) {
    $('#live-chart-line').setAttribute('d', 'M0 120 L720 120');
    $('#live-chart-area').setAttribute('d', 'M0 120 L720 120 L720 190 L0 190Z');
    $('#live-chart-dot').setAttribute('visibility', 'hidden');
    if (chartEmpty) chartEmpty.setAttribute('visibility', 'visible');
    return;
  }
  const min = Math.min(...liveMarket.series) - 30;
  const max = Math.max(...liveMarket.series) + 30;
  const points = liveMarket.series.map((value, index) => {
    const x = (index / (liveMarket.series.length - 1)) * 720;
    const y = 145 - ((value - min) / (max - min)) * 105;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });
  const path = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
  const area = `${path} L720 190 L0 190Z`;
  $('#live-chart-line').setAttribute('d', path);
  $('#live-chart-area').setAttribute('d', area);
  const [lastX, lastY] = points[points.length - 1];
  $('#live-chart-dot').setAttribute('cx', lastX);
  $('#live-chart-dot').setAttribute('cy', lastY);
  $('#live-chart-dot').setAttribute('visibility', 'visible');
  if (chartEmpty) chartEmpty.setAttribute('visibility', 'hidden');
}

function renderLiveMarket() {
  const bestAsk = Number(state.marketBoard?.bestAsk);
  const latestTrade = liveMarket.trades[0];
  $('#live-price').textContent = Number.isFinite(bestAsk) && bestAsk > 0 ? `₩${bestAsk.toLocaleString('ko-KR')}` : '가격 대기';
  $('#last-trade-price').textContent = latestTrade ? `₩${latestTrade.price.toLocaleString('ko-KR')}` : '체결 대기';
  $('#last-trade-time').textContent = latestTrade ? '완료 실물 거래' : '완료 거래 없음';
  $('#live-change').textContent = latestTrade ? '완료 거래 기준' : '체결 데이터 대기';
  $('#live-change').className = 'positive';
  $('#live-inventory').textContent = `${Number(state.marketBoard?.verifiedInventoryQty || 0).toLocaleString('ko-KR')} kg`;
  $('#live-volume').textContent = `${liveMarket.trades.reduce((total, trade) => total + trade.quantity, 0).toLocaleString('ko-KR')} kg`;
  $('#live-event-count').textContent = `${liveMarket.events.length}건`;
  $('#simulation-clock').textContent = new Date(2026, 7, 27, 9, 41, 28 + liveMarket.tick * 3).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  renderLiveBook();
  renderLiveTape();
  renderLiveChart();
}

function pushRealtimeTick() {
  if (realtimePaused) return;
  liveMarket.tick += 1;
  renderLiveMarket();
}

function setRole(role) {
  state.role = role;
  $$('.role-button').forEach((button) => button.classList.toggle('active', button.dataset.role === role));
  $('#split-simulator').classList.toggle('hidden', role !== 'split');
  $('#seller-view').classList.toggle('hidden', role !== 'seller');
  $('#buyer-workspace').classList.toggle('hidden', role === 'seller' || role === 'split' || role === 'operator');
  $('#realtime-console').classList.toggle('hidden', role === 'operator');
  $('#operator-view').classList.toggle('hidden', role !== 'operator');
  const copy = {
    split: ['구매자와 공급자의 화면을<br /><span>동시에 확인하세요.</span>', '양쪽 화면을 연결해 구매자·공급자 체결 과정을 시뮬레이션합니다.'],
    seller: ['검증된 재고를<br /><span>안전하게 거래에 연결합니다.</span>', '재고와 증빙을 확인한 뒤, 구매자의 주문에 책임 있게 응답하세요.'],
    buyer: ['필요한 원료의 조건을<br /><span>먼저 정확하게 확정하세요.</span>', '스펙이 확정된 원료만 가격과 공급을 비교하고, 검증된 재고에 주문을 제출할 수 있습니다.'],
    operator: ['거래소 운영 상태를<br /><span>한 화면에서 통제하세요.</span>', 'AI 팀은 검증과 준비를 자동 수행하고, 위험한 결정은 H-01 승인 대기열에 남깁니다.'],
  }[role];
  $('#page-title').innerHTML = copy[0];
  document.querySelector('.intro-copy').textContent = copy[1];
  syncSplitState();
  if (role === 'operator') hydrateOpsSummary();
  showToast(role === 'split' ? '구매자·공급자 분할 화면으로 전환했습니다.' : role === 'seller' ? '공급자 작업공간으로 전환했습니다.' : role === 'operator' ? '운영 제어탑으로 전환했습니다.' : '구매자 작업공간으로 전환했습니다.');
}

function syncSplitState() {
  const splitButton = $('#split-seller-accept');
  const splitSubmitButton = $('#split-submit-order');
  if (!splitButton) return;
  const price = Number(state.orderPrice || $('#split-bid-price').value || 0);
  const quantity = Number(state.orderQuantity || $('#split-bid-quantity').value || 0);
  const serverReady = ['READY', 'STATE_FALLBACK'].includes(state.marketBoardStatus) && Boolean(getVerifiedOffer());
  if (splitSubmitButton) {
    const specReadiness = getSpecReadiness();
    splitSubmitButton.disabled = state.submitted || !serverReady || !specReadiness.ready;
    splitSubmitButton.innerHTML = state.submitted ? '주문 제출 완료 ✓' : !serverReady ? '검증 매물 확인 중' : specReadiness.ready ? '구매 주문 제출 <span>→</span>' : '스펙 확정 후 주문 가능';
  }
  if (!state.submitted) {
    $('#split-seller-price').textContent = '가격 대기';
    $('#split-seller-quantity').textContent = '주문 대기';
    $('#split-order-badge').textContent = '대기 중';
    $('#split-order-badge').classList.remove('success');
    $('#split-seller-status').className = 'pane-status';
    $('#split-seller-status').innerHTML = '<span class="status-dot"></span>구매자 주문 제출 후 공급자 화면에 표시됩니다.';
    splitButton.disabled = true;
    splitButton.innerHTML = '구매 주문 대기';
    syncLifecycleUI();
    return;
  }
  $('#split-seller-price').textContent = `₩${price.toLocaleString('ko-KR')}/kg`;
  $('#split-seller-quantity').textContent = `${quantity.toLocaleString('ko-KR')} kg`;
  if (state.submitted) {
    splitButton.disabled = false;
    $('#split-order-badge').textContent = state.accepted ? '체결 완료' : '응답 대기';
    $('#split-order-badge').classList.add('success');
    $('#split-buyer-status').className = 'pane-status success';
    $('#split-buyer-status').innerHTML = '<span class="status-dot"></span>주문 제출 완료 · 공급자 응답을 기다리는 중입니다.';
  }
  if (state.accepted) {
    splitButton.disabled = true;
    splitButton.innerHTML = '체결 완료 ✓';
    $('#split-seller-status').className = 'pane-status success';
    $('#split-seller-status').innerHTML = `<span class="status-dot"></span>체결 완료 · 재고 ${Number(state.orderQuantity || quantity).toLocaleString('ko-KR')} kg 잠금`;
    $('#split-order-badge').textContent = '체결 완료';
  }
  syncLifecycleUI();
}

async function submitOrder() {
  const price = Number($('#bid-price').value);
  const quantity = Number($('#bid-quantity').value);
  if (!state.material) return showToast('먼저 원료를 선택해 주세요.');
  if (!price || price < 1) return showToast('매수가를 입력해 주세요.');
  if (!quantity || quantity < 20) return showToast('수량은 최소 20 kg입니다.');
  if (!getVerifiedOffer() || !['READY', 'STATE_FALLBACK'].includes(state.marketBoardStatus)) return showToast('서버 검증 매물과 가용재고를 먼저 확인해 주세요.');
  const specReadiness = getSpecReadiness();
  if (!specReadiness.complete) return showToast('먼저 6개 스펙 항목을 모두 확정해 주세요.');
  if (!specReadiness.matchesVerifiedLot) return showToast('현재 검증된 공급 로트와 일치하는 스펙을 선택해 주세요.');
  const button = $('#submit-order');
  button.disabled = true;
  try {
    const result = await apiRequest('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ specId: 'GABA-SPEC-001', specAttributes: getSpecAttributes(), price, quantity, deliveryDate: $('#delivery-date').value, deliveryDays: 14, idempotencyKey: makeIdempotencyKey('buyer-order') }),
    });
    state.orderId = result.order.orderId;
    state.orderPrice = price;
    state.orderQuantity = quantity;
    state.submitted = true;
    renderSellerIncomingOrder(result.order);
    $('#order-feedback').className = 'order-feedback success';
    $('#order-feedback').innerHTML = `주문이 원장에 기록되었습니다. <strong>검증된 공급자 응답을 기다리는 중입니다.</strong>`;
    $('#status-badge').textContent = '공급자 응답 대기';
    $('#status-badge').classList.add('success');
    $('#timeline-order').classList.add('done');
    $('#timeline-order > span').textContent = '✓';
    $('#timeline-order small').textContent = `${quantity.toLocaleString('ko-KR')} kg · ₩${price.toLocaleString('ko-KR')}/kg 주문 제출 완료`;
    syncSplitState();
    showToast(`주문 ${state.orderId}가 거래 원장에 기록되었습니다.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    updateTradeGate();
  }
}

async function submitSplitOrder() {
  const price = Number($('#split-bid-price').value);
  const quantity = Number($('#split-bid-quantity').value);
  if (!price || price < 1) return showToast('구매자 화면에서 매수가를 입력해 주세요.');
  if (!quantity || quantity < 20) return showToast('구매자 화면의 수량은 최소 20 kg입니다.');
  if (!getVerifiedOffer() || !['READY', 'STATE_FALLBACK'].includes(state.marketBoardStatus)) return showToast('서버 검증 매물과 가용재고를 먼저 확인해 주세요.');
  const specReadiness = getSpecReadiness();
  if (!specReadiness.complete) return showToast('먼저 구매자 화면에서 6개 스펙 항목을 모두 확정해 주세요.');
  if (!specReadiness.matchesVerifiedLot) return showToast('현재 검증된 공급 로트와 일치하는 스펙을 선택해 주세요.');
  const button = $('#split-submit-order');
  button.disabled = true;
  try {
    const result = await apiRequest('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ specId: 'GABA-SPEC-001', specAttributes: getSpecAttributes(), price, quantity, deliveryDate: '2026-09-15', deliveryDays: 14, idempotencyKey: makeIdempotencyKey('split-order') }),
    });
    state.orderId = result.order.orderId;
    state.orderPrice = price;
    state.orderQuantity = quantity;
    state.submitted = true;
    renderSellerIncomingOrder(result.order);
    syncSplitState();
    showToast(`주문 ${state.orderId}가 공급자 화면으로 전달되었습니다.`);
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

async function acceptSplitOrder() {
  if (!state.submitted) return showToast('먼저 구매자 화면에서 주문을 제출해 주세요.');
  if (!state.orderId) return showToast('거래 원장 주문번호가 없습니다.');
  const button = $('#split-seller-accept');
  button.disabled = true;
  try {
    const result = await apiRequest(`/api/orders/${state.orderId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ lotId: 'GBA-KR-2407', idempotencyKey: makeIdempotencyKey('supplier-accept') }),
    });
    state.accepted = true;
    state.tradeId = result.trade.tradeId;
    state.lifecycleStatus = result.trade.status;
    renderSellerIncomingOrder({ orderId: state.orderId, quantity: state.orderQuantity, price: $('#split-bid-price').value, deliveryDate: '2026-09-15' });
    syncSplitState();
    showToast(`${state.tradeId} 체결 완료 · 재고가 잠겼습니다.`);
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

$('#material-search').addEventListener('input', (event) => { resolveMaterialSearch(event.target.value); });

$('#search-suggestion').addEventListener('click', () => {
  if (!materialSearchMatch) return;
  applyMaterialMatch(materialSearchMatch, materialSearchMatch.materialId);
  showToast(`${materialSearchMatch.materialId} 기준 스펙을 불러왔습니다.`);
});
$('#search-suggestion-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-material-id]');
  if (!button) return;
  const match = materialSearchMatches.find((candidate) => candidate.materialId === button.dataset.materialId);
  if (!match) return;
  materialSearchMatch = match;
  applyMaterialMatch(match, match.materialId);
  showToast(`${match.materialId} 기준 스펙을 불러왔습니다.`);
});

bindSpecControls();

$('#bid-price').addEventListener('input', updateTotal);
$('#bid-quantity').addEventListener('input', updateTotal);
$('#submit-order').addEventListener('click', submitOrder);
$('#split-bid-price').addEventListener('input', syncSplitState);
$('#split-bid-quantity').addEventListener('input', syncSplitState);
$('#split-submit-order').addEventListener('click', submitSplitOrder);
$('#split-seller-accept').addEventListener('click', acceptSplitOrder);
$('#seller-deliver').addEventListener('click', deliverTrade);
$('#seller-inspect-pass').addEventListener('click', () => inspectTrade(true));
$('#seller-inspect-fail').addEventListener('click', () => inspectTrade(false));
$('#split-seller-deliver').addEventListener('click', deliverTrade);
$('#split-seller-inspect-pass').addEventListener('click', () => inspectTrade(true));
$('#split-seller-inspect-fail').addEventListener('click', () => inspectTrade(false));

$('#realtime-toggle').addEventListener('click', () => {
  realtimePaused = !realtimePaused;
  $('#realtime-toggle').textContent = realtimePaused ? '재생' : '일시정지';
  $('#realtime-label').textContent = realtimePaused ? 'PAUSED' : 'LIVE SERVER WATCH';
  $('#event-log-state').textContent = realtimePaused ? '감시 일시정지' : '서버 이벤트 감시 중';
  showToast(realtimePaused ? '서버 데이터 감시를 일시정지했습니다.' : '서버 데이터 감시를 다시 시작했습니다.');
});

$$('[data-role]').forEach((button) => button.addEventListener('click', () => setRole(button.dataset.role)));

$$('[data-scroll]').forEach((button) => button.addEventListener('click', () => {
  const target = document.getElementById(button.dataset.scroll);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}));

$('#edit-spec').addEventListener('click', () => {
  document.querySelector('.spec-fields select').focus();
  showToast('스펙 선택 영역을 열었습니다.');
});

$('#guided-spec-start').addEventListener('click', openSpecWizard);
$('#wizard-next').addEventListener('click', advanceSpecWizard);
$('#wizard-back').addEventListener('click', rewindSpecWizard);
$('#wizard-close').addEventListener('click', closeSpecWizard);
$$('[data-wizard-close]').forEach((element) => element.addEventListener('click', closeSpecWizard));

$('#seller-accept').addEventListener('click', async () => {
  if (!state.submitted) {
    showToast('먼저 구매자 화면에서 제출된 주문이 필요합니다.');
    return;
  }
  if (!state.orderId) return showToast('거래 원장 주문번호가 없습니다.');
  try {
    const result = await apiRequest(`/api/orders/${state.orderId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ lotId: 'GBA-KR-2407', idempotencyKey: makeIdempotencyKey('supplier-accept') }),
    });
    state.accepted = true;
    state.tradeId = result.trade.tradeId;
    state.lifecycleStatus = result.trade.status;
    renderSellerIncomingOrder({ orderId: state.orderId, quantity: state.orderQuantity, price: $('#bid-price').value, deliveryDate: $('#delivery-date').value });
    $('#seller-accept').textContent = '체결 완료 ✓';
    $('#seller-accept').disabled = true;
    $('#seller-accept').style.opacity = '.7';
    $('#status-badge').textContent = '체결 완료';
    $('#timeline-order').nextElementSibling.classList.add('done');
    $('#timeline-order').nextElementSibling.querySelector('span').textContent = '✓';
    $('#timeline-order').nextElementSibling.querySelector('small').textContent = `${state.tradeId} · 공급자가 주문을 체결했습니다.`;
    syncLifecycleUI();
    showToast(`${state.tradeId} 체결 완료 · 재고 잠금 상태입니다.`);
  } catch (error) {
    showToast(error.message);
  }
});

async function deliverTrade() {
  if (!state.tradeId) return showToast('먼저 공급자 체결이 필요합니다.');
  const buttons = ['#seller-deliver', '#split-seller-deliver'].map((selector) => $(selector)).filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await apiRequest(`/api/trades/${state.tradeId}/deliver`, { method: 'POST', body: JSON.stringify({}) });
    state.lifecycleStatus = result.trade.status;
    syncLifecycleUI();
    showToast(`${state.tradeId} 납품 기록이 원장에 반영되었습니다.`);
  } catch (error) { showToast(error.message); syncLifecycleUI(); }
}

async function inspectTrade(qualityPass) {
  if (!state.tradeId) return showToast('먼저 공급자 체결이 필요합니다.');
  try {
    const result = await apiRequest(`/api/trades/${state.tradeId}/inspect`, { method: 'POST', body: JSON.stringify({ specMatch: qualityPass, qualityPass, note: qualityPass ? '베타 검수 통과' : '베타 검수 불일치' }) });
    state.lifecycleStatus = result.trade.status;
    syncLifecycleUI();
    showToast(qualityPass ? '검수 통과 · 완료 거래로 기록되었습니다.' : '불일치 확인 · 로트를 격리했습니다.');
  } catch (error) { showToast(error.message); }
}

$('#add-inventory').addEventListener('click', async () => {
  const form = $('#supplier-verification-form');
  form.classList.toggle('hidden');
  await hydrateSupplierEligibility();
  showToast(form.classList.contains('hidden') ? '공급자 자격 요청 입력을 닫았습니다.' : '검증 참조를 입력하면 H-01 검토 큐로 접수됩니다.');
});
$('#refresh-supplier-eligibility').addEventListener('click', hydrateSupplierEligibility);
$('#supplier-verification-form').addEventListener('submit', requestSupplierVerification);
updateTotal();
updateSpecState();
renderLiveMarket();
hydratePriceIndex();
hydrateBackendState();
hydrateMarketBoard();
hydrateMaterialSpec();
hydrateSupplierEligibility();
connectLedgerStream();
window.setInterval(pushRealtimeTick, 3000);
const initialRole = new URLSearchParams(window.location.search).get('role');
const roleAliases = { split: 'split', buyer: 'buyer', seller: 'seller', supplier: 'seller', operator: 'operator' };
setRole(roleAliases[initialRole] || 'split');

