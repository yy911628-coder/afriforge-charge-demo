/* The sandbox recording workflow lives in recording.js. Legacy wallet/card examples remain local. */
const HAIDER_BASE_URL = window.AFE_CONFIG?.HAIDER_BASE_URL || 'https://haider-api.example.invalid';
const PEACH_BASE_URL = window.AFE_CONFIG?.PEACH_BASE_URL || 'https://peach-api.example.invalid';
const AFE_BASE_URL = window.AFE_CONFIG?.AFE_BASE_URL || '';
const AFE_API_MOCK_MODE = false;
const AFE_API_MOCK_DELAY_MS = 1500;
const AFE_CARD_TOKEN_KEY = 'afeChargeMockCardToken';
const AFE_CARD_LAST4_KEY = 'afeChargeMockCardLast4';
const afeMockSessions = new Map();
const AFE_CHARGE_TRANSITIONS = Object.freeze({
  idle: ['validating'], completed: ['validating'], failed: ['validating'],
  validating: ['preauthorizing', 'starting', 'failed'],
  preauthorizing: ['starting', 'voiding', 'failed'],
  starting: ['awaitingCommandResult', 'voiding', 'failed'],
  awaitingCommandResult: ['charging', 'voiding', 'failed'],
  voiding: ['failed'], charging: ['stopping'], stopping: ['settling', 'charging', 'failed'],
  settling: ['completed']
});
function setAfeChargeState(next) {
  const current = appState.chargeState || 'idle';
  if (current === next) return true;
  if (!AFE_CHARGE_TRANSITIONS[current]?.includes(next)) {
    console.warn(`AFE demo state transition blocked: ${current} → ${next}`);
    return false;
  }
  appState.chargeState = next;
  return true;
}

function afeMockRequest(baseUrl, path, request, makeResponse, failMessage = '') {
  // These two account screens intentionally demonstrate a local wallet. Never forward
  // their sample identifiers or balances to a payment or charging backend.
  if (!['/api/peach/cards/tokenize', '/api/peach/wallet/top-ups'].includes(path)) {
    return Promise.reject(new Error('Open the Hardhitter sandbox on the Home tab.'));
  }
  return new Promise((resolve, reject) => window.setTimeout(() => {
    if (failMessage) return reject(new Error(failMessage));
    try { resolve({ mock: true, endpoint: `${baseUrl}${path}`, ...makeResponse() }); }
    catch (error) { reject(error); }
  }, AFE_API_MOCK_DELAY_MS));
}

const AFEApi = {
  mock: AFE_API_MOCK_MODE,
  AFE_BASE_URL,
  HAIDER_BASE_URL,
  PEACH_BASE_URL,
  mockDelayMs: AFE_API_MOCK_DELAY_MS,

  validateFunding({ paymentMethod, cardToken, walletBalance }) {
    return afeMockRequest(AFE_BASE_URL, '/api/account/charge-readiness', { method: 'POST', body: { paymentMethod, walletBalance } }, () => {
      const cardReady = typeof cardToken === 'string' && cardToken.startsWith('MOCK_CARD_');
      const walletReady = Number(walletBalance) > 0;
      const allowed = paymentMethod === 'fleet' || (paymentMethod === 'card' ? cardReady : paymentMethod === 'wallet' && walletReady);
      return { allowed, cardReady, walletReady, paymentMethod, checkedAt: new Date().toISOString() };
    });
  },

  peachCreateCardToken({ last4 }) {
    return afeMockRequest(PEACH_BASE_URL, '/api/peach/cards/tokenize', { method: 'POST', body: { last4 } }, () => ({
      cardToken: `MOCK_CARD_${Date.now().toString(36).toUpperCase()}`,
      brand: 'Visa', last4: String(last4).slice(-4), status: 'TOKENIZED'
    }));
  },

  peachPreAuthorize({ cardToken, amount, reference, failure }) {
    return afeMockRequest(PEACH_BASE_URL, '/api/peach/payments/pre-authorizations', { method: 'POST', body: { amount, reference } }, () => ({
      authorizationId: `MOCK_AUTH_${Date.now().toString(36).toUpperCase()}`,
      authorizedAmount: Number(amount), currency: 'ZAR', status: 'AUTHORIZED', reference
    }), !cardToken ? 'No Peach card token is linked to this demo account.' : failure === 'payment' ? 'Demo card pre-authorisation was declined.' : '');
  },

  peachCapture({ authorizationId, amount, reference }) {
    return afeMockRequest(PEACH_BASE_URL, `/api/peach/payments/${encodeURIComponent(authorizationId)}/capture`, { method: 'POST', body: { amount, reference } }, () => ({
      captureId: `MOCK_CAPTURE_${Date.now().toString(36).toUpperCase()}`,
      capturedAmount: Number(amount), currency: 'ZAR', status: 'CAPTURED', reference
    }));
  },

  peachRelease({ authorizationId, amount, reference }) {
    return afeMockRequest(PEACH_BASE_URL, `/api/peach/payments/${encodeURIComponent(authorizationId)}/release`, { method: 'POST', body: { amount, reference } }, () => ({
      releaseId: `MOCK_RELEASE_${Date.now().toString(36).toUpperCase()}`,
      releasedAmount: Number(amount), currency: 'ZAR', status: 'RELEASED', reference
    }));
  },

  peachWalletTopUp({ cardToken, amount, reference }) {
    return afeMockRequest(PEACH_BASE_URL, '/api/peach/wallet/top-ups', { method: 'POST', body: { amount, reference } }, () => ({
      paymentId: `MOCK_TOPUP_${Date.now().toString(36).toUpperCase()}`,
      paidAmount: Number(amount), currency: 'ZAR', status: 'SUCCESS', reference
    }), !cardToken ? 'Bind a demo card before topping up.' : '');
  },

  haiderStartCharge({ sessionId, stationId, connectorId, chargerCode, failure }) {
    const path = '/api/haider/start-charge';
    const ocpiCommand = {
      command: 'START_SESSION',
      response_url: 'https://afe-charge.example.invalid/api/ocpi/command-response',
      token: { country_code: 'ZA', party_id: 'AFE', uid: 'AFE-DEMO-USER', type: 'APP_USER' },
      location_id: stationId,
      // Demo mapping only; Haider must confirm the real Location/EVSE/Connector IDs.
      evse_uid: `DEMO-EVSE-${stationId}`,
      connector_id: connectorId,
      authorization_reference: sessionId
    };
    return afeMockRequest(HAIDER_BASE_URL, path, {
      method: 'POST', body: { sessionId, stationId, connectorId, chargerCode, ocpiCommand }
    }, () => {
      if (failure === 'gun') throw new Error('Haider reports that this connector is faulted.');
      if (failure === 'communication') throw new Error('Haider did not respond before the demo timeout.');
      // OCPI's immediate CommandResponse can be ACCEPTED before the charge has
      // actually started. Model that asynchronous gap instead of treating it
      // as a successful start.
      const session = { sessionId, stationId, connectorId, status: 'START_PENDING', startedAt: Date.now(), meter: null };
      afeMockSessions.set(sessionId, session);
      return { commandId: `MOCK_CMD_${Date.now().toString(36).toUpperCase()}`, status: 'ACCEPTED', sessionId, ocpiCommand };
    }).catch(error => { throw error; });
  },

  haiderAwaitStartResult({ sessionId, commandId }) {
    return afeMockRequest(HAIDER_BASE_URL, `/api/haider/commands/${encodeURIComponent(commandId)}/result`, { method: 'GET' }, () => {
      const session = afeMockSessions.get(sessionId);
      if (!session) throw new Error('The demo charging session could not be found.');
      session.status = 'CHARGING';
      session.commandResult = 'ACCEPTED';
      return { sessionId, result: 'ACCEPTED', status: session.status };
    });
  },

  haiderRequestStop({ sessionId, stationId, connectorId, energy, cost, reason }) {
    const session = afeMockSessions.get(sessionId);
    const ocpiCommand = {
      command: 'STOP_SESSION',
      response_url: 'https://afe-charge.example.invalid/api/ocpi/command-response',
      session_id: sessionId
    };
    return afeMockRequest(HAIDER_BASE_URL, '/api/haider/stop-charge', {
      method: 'POST', body: { sessionId, stationId, connectorId, reason, ocpiCommand }
    }, () => {
      if (!session) throw new Error('The demo charging session could not be found.');
      session.status = 'COMPLETED';
      session.endedAt = Date.now();
      session.meter = { energy: Number(energy) || 0, cost: Number(cost) || 0, reason: String(reason || 'Stopped') };
      session.ocpiCommand = ocpiCommand;
      return { commandId: `MOCK_CMD_${Date.now().toString(36).toUpperCase()}`, status: 'ACCEPTED', sessionId };
    });
  },

  haiderGetChargeStatus({ sessionId }) {
    return afeMockRequest(HAIDER_BASE_URL, `/api/haider/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' }, () => {
      const session = afeMockSessions.get(sessionId);
      if (!session) throw new Error('The demo charging session could not be found.');
      return { status: session.status, sessionId, endedAt: session.endedAt || null, meter: session.meter || null };
    });
  }
};
window.AFEApi = AFEApi;

const AFE_FLOW_COPY = {
  en: {
    fundingTitle: 'Payment method needed', fundingBody: 'Bind a card or add wallet funds before starting a personal charge.', bindCard: 'Bind a card', topUpWallet: 'Top up wallet', cancel: 'Not now',
    noCard: 'No card token linked', cardReady: 'Mock card token linked', bindCardHint: 'Card number, expiry and CVV are checked in this demo form, then discarded.', makeToken: 'Create demo card token', savingCard: 'Creating secure demo token…',
    demoOnly: 'Demo only · no real charger command or payment is made.', payCard: 'Card', payWallet: 'Wallet', cardNotBound: 'Bind a card to use card pre-authorisation.', walletNotEnough: 'Wallet has no available demo balance.',
    stepCheck: 'Checking payment account…', stepPreauth: 'Placing card pre-authorisation…', stepStart: 'Sending OCPI start request to Haider…', stepCommandResult: 'Waiting for Haider’s asynchronous start result…', stepStop: 'Waiting for Haider stop confirmation…', stepCapture: 'Capturing the actual amount…', stepRelease: 'Releasing the unused card hold…',
    fieldCardNumber: 'Card number', fieldExpiry: 'Expiry', fieldCvv: 'CVV', invalidCard: 'Enter a valid demo card number', invalidExpiry: 'Expiry must use MM/YY and be in the future', invalidCvv: 'CVV must be 3–4 digits', walletCapLabel: 'Wallet spend limit · no card hold', chargeLimit: 'Charge limit',
    startedToast: '【AFE Charge】Your vehicle has started charging.', paymentToast: '【AFE Charge】Charging ended. R {amount} was charged to your card ending {last4}.', walletToast: '【AFE Charge】Charging ended. R {amount} was settled from your demo wallet.',
    preauthFailed: 'Card pre-authorisation failed. No charge was started.', startFailed: 'The charger did not start. Any demo card hold has been released.', settlementFailed: 'Settlement is pending. Tap to retry.', cardSaved: 'Demo card token created. Full card details were discarded.', topupSuccess: 'Demo top-up complete', walletLimit: 'The session limit was reduced to your available wallet balance.'
  },
  zh: {
    fundingTitle: '需要付款方式', fundingBody: '启动个人充电前，请先绑定银行卡或为钱包充值。', bindCard: '绑定银行卡', topUpWallet: '钱包充值', cancel: '暂不',
    noCard: '尚未绑定银行卡 Token', cardReady: '模拟银行卡 Token 已绑定', bindCardHint: '本演示仅在本地校验卡号、有效期和 CVV，随后立即丢弃。', makeToken: '生成模拟银行卡 Token', savingCard: '正在生成模拟 Token…',
    demoOnly: '仅为演示 · 不会发送真实充电指令或支付。', payCard: '银行卡', payWallet: '钱包', cardNotBound: '绑定银行卡后才能使用预授权。', walletNotEnough: '钱包暂无可用演示余额。',
    stepCheck: '正在校验付款账户…', stepPreauth: '正在模拟银行卡预授权…', stepStart: '正在向海汇德发送 OCPI 启动请求…', stepCommandResult: '正在等待海汇德异步启动结果…', stepStop: '正在等待海汇德确认结束…', stepCapture: '正在模拟请款实际消费…', stepRelease: '正在释放未使用的预授权…',
    fieldCardNumber: '银行卡号', fieldExpiry: '有效期', fieldCvv: '安全码 CVV', invalidCard: '请输入有效的演示银行卡号', invalidExpiry: '有效期请填写 MM/YY 且不能过期', invalidCvv: 'CVV 应为 3–4 位数字', walletCapLabel: '钱包消费限额 · 不冻结银行卡', chargeLimit: '充电限额',
    startedToast: '【AFE Charge】您的车辆已开始充电', paymentToast: '【AFE Charge】充电结束，已从尾号 {last4} 卡模拟扣款 R {amount}', walletToast: '【AFE Charge】充电结束，已从演示钱包结算 R {amount}',
    preauthFailed: '银行卡预授权失败，充电未启动。', startFailed: '充电桩未能启动，已释放模拟预授权。', settlementFailed: '结算尚未完成，点击重试。', cardSaved: '模拟银行卡 Token 已生成，完整卡片信息已丢弃。', topupSuccess: '模拟充值成功', walletLimit: '充电限额已调整为钱包当前可用余额。'
  },
  af: {
    fundingTitle: 'Betaalmetode benodig', fundingBody: 'Koppel ’n kaart of laai jou beursie voordat jy begin laai.', bindCard: 'Koppel kaart', topUpWallet: 'Vul beursie aan', cancel: 'Nie nou nie',
    noCard: 'Geen kaarttoken gekoppel nie', cardReady: 'Demo-kaarttoken gekoppel', bindCardHint: 'Kaartbesonderhede word plaaslik nagegaan en daarna weggegooi.', makeToken: 'Skep demo-kaarttoken', savingCard: 'Demo-token word geskep…',
    demoOnly: 'Slegs demo · geen regte laaibevel of betaling nie.', payCard: 'Kaart', payWallet: 'Beursie', cardNotBound: 'Koppel ’n kaart vir kaartmagtiging.', walletNotEnough: 'Geen demo-beursiesaldo beskikbaar nie.',
    stepCheck: 'Betaalrekening word nagegaan…', stepPreauth: 'Kaartmagtiging word geplaas…', stepStart: 'OCPI-beginversoek word na Haider gestuur…', stepCommandResult: 'Wag vir Haider se asinchroniese beginresultaat…', stepStop: 'Wag vir Haider se stopbevestiging…', stepCapture: 'Werklike bedrag word gehef…', stepRelease: 'Oorblywende magtiging word vrygestel…',
    fieldCardNumber: 'Kaartnommer', fieldExpiry: 'Vervaldatum', fieldCvv: 'CVV', invalidCard: 'Voer ’n geldige demo-kaartnommer in', invalidExpiry: 'Vervaldatum moet MM/YY wees en nog geldig wees', invalidCvv: 'CVV moet 3–4 syfers hê', walletCapLabel: 'Beursielimiet · geen kaarthou nie', chargeLimit: 'Laailimiet',
    startedToast: '【AFE Charge】Jou voertuig het begin laai.', paymentToast: '【AFE Charge】Laaing klaar. R {amount} is van kaart •••• {last4} gehef.', walletToast: '【AFE Charge】Laaing klaar. R {amount} is van jou demo-beursie vereffen.',
    preauthFailed: 'Kaartmagtiging het misluk. Geen laai het begin nie.', startFailed: 'Die laaier het nie begin nie. Die demo-kaarthou is vrygestel.', settlementFailed: 'Vereffening is hangend. Tik om weer te probeer.', cardSaved: 'Demo-kaarttoken geskep; kaartbesonderhede is weggegooi.', topupSuccess: 'Demo-beursie aangevul', walletLimit: 'Die sessielimiet is tot jou beskikbare beursiesaldo beperk.'
  },
  zu: {
    fundingTitle: 'Kudingeka indlela yokukhokha', fundingBody: 'Xhumanisa ikhadi noma ufake imali esikhwameni ngaphambi kokuqala ukushaja.', bindCard: 'Xhumanisa ikhadi', topUpWallet: 'Faka imali esikhwameni', cancel: 'Hhayi manje',
    noCard: 'Alikho ithokheni lekhadi elixhunyiwe', cardReady: 'Ithokheni lekhadi ledemo lixhunyiwe', bindCardHint: 'Imininingwane yekhadi ihlolwa kule demo bese iyasuswa.', makeToken: 'Dala ithokheni lekhadi ledemo', savingCard: 'Kwenziwa ithokheni ledemo…',
    demoOnly: 'Idemo kuphela · akukho myalo wangempela noma inkokhelo.', payCard: 'Ikhadi', payWallet: 'Isikhwama', cardNotBound: 'Xhumanisa ikhadi ukuze usebenzise ukugunyazwa kwangaphambili.', walletNotEnough: 'Asikho isikweletu sedemo esitholakalayo esikhwameni.',
    stepCheck: 'Kuhlolwa i-akhawunti yokukhokha…', stepPreauth: 'Kugunyazwa ikhadi ngaphambi kwesikhathi…', stepStart: 'Kuthunyelwa isicelo se-OCPI ku-Haider…', stepCommandResult: 'Kulindwe impendulo yokuqala evela ku-Haider…', stepStop: 'Kulindwe ukuqinisekiswa kokuma okuvela ku-Haider…', stepCapture: 'Kukhokhiswa inani langempela…', stepRelease: 'Kudedelwa imali engagunyaziwe…',
    fieldCardNumber: 'Inombolo yekhadi', fieldExpiry: 'Usuku lokuphelelwa yisikhathi', fieldCvv: 'CVV', invalidCard: 'Faka inombolo yekhadi ledemo evumelekile', invalidExpiry: 'Usuku kufanele lube yi-MM/YY futhi lube sesikhathini esizayo', invalidCvv: 'I-CVV kufanele ibe namadijithi angu-3–4', walletCapLabel: 'Umkhawulo wesikhwama · akukho mali ebanjwayo ekhadini', chargeLimit: 'Umkhawulo wokushaja',
    startedToast: '【AFE Charge】Imoto yakho isiqalile ukushaja.', paymentToast: '【AFE Charge】Ukushaja kuphelile. R {amount} ikhokhiswe ekhadini eliphela ngo-{last4}.', walletToast: '【AFE Charge】Ukushaja kuphelile. R {amount} kukhokhiswe esikhwameni sedemo.',
    preauthFailed: 'Ukugunyazwa kwekhadi kwehlulekile. Ukushaja akuqalanga.', startFailed: 'Ishaja ayiqalanga. Imali ebibanjwe yedemo isidedeliwe.', settlementFailed: 'Inkokhelo isalindile. Thepha ukuze uzame futhi.', cardSaved: 'Ithokheni lekhadi ledemo lenziwe; imininingwane egcwele isusiwe.', topupSuccess: 'Imali yedemo ifakiwe', walletLimit: 'Umkhawulo weseshini uncishiswe waba yimali etholakala esikhwameni.'
  }
};
function afeFlowText(key, vars = {}) {
  const language = ['en', 'zh', 'af', 'zu'].includes(store.language) ? store.language : 'en';
  return String(AFE_FLOW_COPY[language][key] || AFE_FLOW_COPY.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
}
function afeHasCardToken() { return typeof store.cardToken === 'string' && store.cardToken.startsWith('MOCK_CARD_'); }
function afeReadCardToken() {
  try {
    store.cardToken = localStorage.getItem(AFE_CARD_TOKEN_KEY) || null;
    const last4 = localStorage.getItem(AFE_CARD_LAST4_KEY);
    if (last4 && /^\d{4}$/.test(last4)) store.cardLast4 = last4;
  } catch { store.cardToken = null; }
  return store.cardToken;
}
afeReadCardToken();

function showFundingGate() {
  const root = document.getElementById('overlayRoot');
  if (!root) { toast(afeFlowText('fundingBody')); return; }
  root.innerHTML = `<div class="app-filter" onclick="if(event.target===this)closeFundingGate()"><section class="app-sheet" role="dialog" aria-modal="true" aria-labelledby="afe-funding-title"><div class="wallet-sheet-grab"></div><h2 id="afe-funding-title">${esc(afeFlowText('fundingTitle'))}</h2><p class="app-muted">${esc(afeFlowText('fundingBody'))}</p><button class="app-button full" onclick="closeFundingGate();showPage('cardForm')">${esc(afeFlowText('bindCard'))}</button><button class="app-button secondary full" style="margin-top:8px" onclick="closeFundingGate();showPage('wallet')">${esc(afeFlowText('topUpWallet'))}</button><button class="app-button ghost full" onclick="closeFundingGate()">${esc(afeFlowText('cancel'))}</button><div class="app-notice">${esc(afeFlowText('demoOnly'))}</div></section></div>`;
}
function closeFundingGate() { const root = document.getElementById('overlayRoot'); if (root) root.innerHTML = ''; }
function afeEffectivePayment() {
  let method = appState.payment || store.payment || 'card';
  if (method === 'card' && !afeHasCardToken() && Number(store.wallet) > 0) method = 'wallet';
  if (method === 'wallet' && Number(store.wallet) <= 0 && afeHasCardToken()) method = 'card';
  appState.payment = method;
  store.payment = method;
  return method;
}
function afeSetFailure(kind) {
  appState.failure = kind === 'communication' ? 'communication' : kind === 'gun' ? 'gun' : kind === 'payment' ? 'payment' : 'none';
  appState.page = 'failure';
  setAfeChargeState('failed');
  appState.apiBusy = false;
  appState.apiFlow = null;
  render();
  toast(kind === 'payment' ? afeFlowText('preauthFailed') : afeFlowText('startFailed'));
}

function renderApiFlow() {
  const stopping = appState.page === 'apiStopping';
  const settling = appState.page === 'settling';
  const keys = stopping ? ['stepStop'] : settling ? ['stepCapture', 'stepRelease'] : ['stepCheck', ...(appState.apiFlow?.method === 'card' ? ['stepPreauth'] : []), 'stepStart', 'stepCommandResult'];
  const activeIndex = Math.min(appState.apiFlow?.index || 0, keys.length - 1);
  const stage = appState.apiFlow?.stage;
  const titleKey = stopping ? 'stepStop' : settling ? stage === 'release' ? 'stepRelease' : 'stepCapture' : stage === 'preauth' ? 'stepPreauth' : stage === 'start' ? 'stepStart' : stage === 'commandResult' ? 'stepCommandResult' : 'stepCheck';
  shell(`<section class="connection-screen api-flow-screen"><div class="connection-orb"><div class="connection-spinner">${settling ? '¤' : '↻'}</div></div><div class="app-small">AFE CHARGE · DEMO</div><h1>${esc(afeFlowText(titleKey))}</h1><div class="connection-steps">${keys.map((key, index) => `<div class="connection-step ${index === activeIndex ? 'active' : ''} ${index < activeIndex ? 'done' : ''}"><span class="connection-step-icon">${index < activeIndex ? '✓' : index === activeIndex ? '↻' : '·'}</span><span>${esc(afeFlowText(key))}</span></div>`).join('')}</div>${appState.settlementError ? `<button class="app-button full" onclick="retryAfeSettlement()">${esc(afeFlowText('settlementFailed'))}</button>` : ''}<p class="connection-boundary">${esc(afeFlowText('demoOnly'))}</p></section>`);
}
function renderGuestApi() {
  const s = station(), c = connector(s), hasCard = afeHasCardToken(), hasWallet = Number(store.wallet) > 0;
  const method = afeEffectivePayment();
  const canStart = hasCard || hasWallet;
  shell(`<button class="app-button ghost" onclick="showPage('scan')">‹ ${t('scanTitle')}</button><div class="app-card"><div class="app-small">${t('guestMode')} · DEMO</div><h1>${esc(s.name)}</h1><p class="app-muted">${esc(c.label)} · ${c.kw} kW · ${money(s.rate)} / kWh · VAT included</p><div class="app-divider"></div><h3>${esc(afeFlowText('payCard'))} / ${esc(afeFlowText('payWallet'))}</h3><div class="app-connector ${method === 'card' && hasCard ? 'selected' : ''}"><button onclick="setPayment('card')" ${hasCard ? '' : 'disabled'}><div class="app-row"><b>${hasCard ? `Visa •••• ${esc(store.cardLast4)}` : esc(afeFlowText('noCard'))}</b><span>${method === 'card' && hasCard ? '✓' : ''}</span></div><div class="app-muted">${esc(hasCard ? afeFlowText('cardReady') : afeFlowText('cardNotBound'))}</div></button></div><div class="app-connector ${method === 'wallet' && hasWallet ? 'selected' : ''}"><button onclick="setPayment('wallet')" ${hasWallet ? '' : 'disabled'}><div class="app-row"><b>${esc(afeFlowText('payWallet'))} · ${money(store.wallet)}</b><span>${method === 'wallet' && hasWallet ? '✓' : ''}</span></div><div class="app-muted">${esc(hasWallet ? afeFlowText('demoOnly') : afeFlowText('walletNotEnough'))}</div></button></div>${!hasCard ? `<button class="app-button secondary full" onclick="showPage('cardForm')">＋ ${esc(afeFlowText('bindCard'))}</button>` : ''}<label class="app-label">${t('authorise')}</label><select class="app-select" id="guestLimitSelect" onchange="appState.guestLimit=Number(this.value)"><option value="100" ${appState.guestLimit===100?'selected':''}>R 100</option><option value="200" ${appState.guestLimit===200?'selected':''}>R 200</option><option value="300" ${appState.guestLimit===300?'selected':''}>R 300</option><option value="500" ${appState.guestLimit===500?'selected':''}>R 500</option></select><div class="app-notice">${esc(afeFlowText('demoOnly'))} ${method === 'card' ? `${t('authorise')}: ${money(appState.guestLimit)}` : `${t('availableBalance')}: ${money(store.wallet)}`}</div></div><button class="app-button full" onclick="beginGuestConnection()">${t('start')} →</button><p class="app-muted" style="text-align:center">${esc(afeFlowText('demoOnly'))}</p>`);
    if (!canStart) { const button = document.querySelector('.app-main > .app-button.full'); if (button) button.textContent = afeFlowText('fundingTitle'); }
}
function renderSetupApi() {
  if (appState.customerType !== 'fleet') afeEffectivePayment();
  renderSetupAfeBase();
  if (appState.customerType === 'fleet') return;
  const main = document.querySelector('.app-main');
  const choices = main?.querySelectorAll('.app-connector');
  if (appState.payment === 'wallet') {
    const paymentCard = [...(main?.querySelectorAll('.app-card') || [])].find(card => card.querySelector('.app-connector'));
    const estimate = paymentCard?.querySelector('#estimateLine span');
    if (estimate) estimate.textContent = afeFlowText('walletCapLabel');
  }
  if (afeHasCardToken()) return;
  if (choices?.length) {
    const card = choices[0];
    const label = card.querySelector('.app-row b');
    if (label) label.textContent = afeFlowText('noCard');
    const hint = card.querySelector('.app-muted');
    if (hint) hint.textContent = afeFlowText('cardNotBound');
    const button = card.querySelector('button');
    if (button) { button.disabled = true; button.setAttribute('aria-disabled', 'true'); }
    card.insertAdjacentHTML('afterend', `<button class="app-button ghost full" onclick="showPage('cardForm')">＋ ${esc(afeFlowText('bindCard'))}</button>`);
  }
  if (!(Number(store.wallet) > 0)) main?.insertAdjacentHTML('afterbegin', `<div class="app-notice">${esc(afeFlowText('fundingBody'))}</div>`);
}
const renderSetupAfeBase = renderSetup;
renderSetup = renderSetupApi;
renderGuest = renderGuestApi;

const renderPaymentsAfeBase = renderPayments;
renderPayments = function renderPaymentsApi() {
  const hasCard = afeHasCardToken();
  shell(`<button class="app-button ghost" onclick="showPage('profile')">‹ ${t('me')}</button><div class="app-small">AFE CHARGE · DEMO</div><h1>${t('payment')} methods</h1><div class="app-notice">${esc(afeFlowText('demoOnly'))}</div><section class="app-card"><div class="app-row"><h3>${esc(afeFlowText('payCard'))}</h3><span class="app-badge">${esc(hasCard ? afeFlowText('cardReady') : afeFlowText('noCard'))}</span></div><p class="app-muted">${esc(hasCard ? `Visa •••• ${store.cardLast4}` : afeFlowText('cardNotBound'))}</p><button class="app-button secondary full" onclick="showPage('cardForm')">${hasCard ? t('change') : '＋ ' + esc(afeFlowText('bindCard'))}</button></section><section class="app-card"><div class="app-row"><h3>${esc(afeFlowText('payWallet'))}</h3><strong>${money(store.wallet)}</strong></div><p class="app-muted">${t('demoBalanceLocal')}</p><button class="app-button full" onclick="showPage('wallet');openTopUpSheet()">${esc(afeFlowText('topUpWallet'))}</button></section>`);
};
renderCardForm = function renderCardFormApi() {
  const notice = store.language === 'zh'
    ? '仅创建虚拟测试卡，不需要也不能输入真实银行卡信息。正式绑卡将在支付机构的安全页面完成。'
    : 'Create a fictional test card only. Do not enter real card details. Real card linking will use the payment provider’s secure page.';
  shell(`<button class="app-button ghost" onclick="showPage('payments')">‹ ${t('payment')}</button><div class="app-small">AFE CHARGE · DEMO</div><h1>${esc(afeFlowText('bindCard'))}</h1><div class="app-notice">${esc(notice)}</div><section class="app-card"><p class="app-muted">Demo card · •••• 1234</p><button id="afeSaveCard" class="app-button full" type="button" onclick="saveDemoCard()">${esc(afeFlowText('makeToken'))}</button><p class="app-muted" style="margin:10px 0 0">${esc(afeFlowText('demoOnly'))}</p></section>`);
};

async function saveDemoCard() {
  if (appState.cardBindBusy) return;
  // The demo never collects card details. A production integration must use
  // the provider's hosted flow and an authenticated server-side adapter.
  const last4 = '1234';
  appState.cardBindBusy = true;
  const button = document.getElementById('afeSaveCard'); if (button) { button.disabled = true; button.textContent = afeFlowText('savingCard'); }
  try {
    const result = await AFEApi.peachCreateCardToken({ last4 });
    store.cardToken = result.cardToken;
    store.cardLast4 = result.last4;
    store.payment = appState.payment = 'card';
    try { localStorage.setItem(AFE_CARD_TOKEN_KEY, result.cardToken); localStorage.setItem(AFE_CARD_LAST4_KEY, result.last4); } catch {}
    saveStore();
    toast(afeFlowText('cardSaved'));
    const pending = appState.pendingTopUp;
    appState.pendingTopUp = null;
    showPage(pending ? 'wallet' : 'payments');
    if (pending) topUpWallet(pending.amount, pending.bonus);
  } catch (error) { toast(error.message || 'Could not create the demo card token'); if (button) button.disabled = false; }
  finally { appState.cardBindBusy = false; }
}

function setPayment(mode) {
  if (mode === 'card' && !afeHasCardToken()) { toast(afeFlowText('cardNotBound')); showPage('cardForm'); return; }
  if (mode === 'wallet' && Number(store.wallet) <= 0) { toast(afeFlowText('walletNotEnough')); showPage('wallet'); return; }
  appState.payment = store.payment = mode === 'wallet' ? 'wallet' : 'card'; saveStore();
  if (appState.page === 'guest') renderGuest(); else if (appState.page === 'setup') renderSetup(); else if (appState.page === 'payments') renderPayments();
}
function setPaymentPref(mode) {
  if (mode === 'card' && !afeHasCardToken()) { toast(afeFlowText('cardNotBound')); showPage('cardForm'); return; }
  if (mode === 'wallet' && Number(store.wallet) <= 0) { toast(afeFlowText('walletNotEnough')); showPage('wallet'); return; }
  appState.payment = store.payment = mode === 'wallet' ? 'wallet' : 'card'; saveStore(); renderPayments();
}

async function startAfeCharge({ guest = false } = {}) {
  if (appState.apiBusy || appState.active) return;
  const s = station(), c = connector(s), rawLimit = Number(guest ? appState.guestLimit : appState.limit);
  if (!s || !c || !rawLimit || rawLimit < 1) { toast('Enter a valid charge limit'); return; }
  if (!stationOnline(s) || effectiveConnectorStatus(c) !== 'Available' || !isStartable(s)) { toast(t('connectorUnavailable')); return; }
  const fleet = !guest && appState.customerType === 'fleet';
  let method = fleet ? 'fleet' : afeEffectivePayment();
  if (!fleet && !afeHasCardToken() && !(Number(store.wallet) > 0)) { showFundingGate(); return; }
  if (!fleet && method === 'card' && !afeHasCardToken()) { method = 'wallet'; appState.payment = store.payment = method; }
  if (!fleet && method === 'wallet' && !(Number(store.wallet) > 0)) {
    if (afeHasCardToken()) method = appState.payment = store.payment = 'card';
    else { showFundingGate(); return; }
  }
  const requestedCap = guest ? rawLimit : appState.mode === 'amount' ? rawLimit : appState.mode === 'energy' ? rawLimit * s.rate : Math.max(20, (rawLimit - 35) * .9 * s.rate);
  const cap = !fleet && method === 'wallet' ? Math.min(requestedCap, Number(store.wallet)) : requestedCap;
  if (!fleet && method === 'wallet' && cap < requestedCap) toast(afeFlowText('walletLimit'));
  const sessionId = `${guest ? 'AFE-G' : 'AFE'}-${Date.now().toString().slice(-8)}`;
  const active = {
    id: sessionId, stationId: s.id, connectorId: c.id, mode: guest ? 'amount' : appState.mode,
    limit: guest ? cap : rawLimit, cap, energy: 0, cost: 0, started: Date.now(), customerType: fleet ? 'fleet' : 'personal',
    payment: method, preauth: !fleet && method === 'card' ? cap : 0, preauthId: null, guest,
    fleetVehicleId: fleet ? DEMO_DATA.fleet.vehicleId : null, fleetPlate: fleet ? DEMO_DATA.fleet.plate : null,
    cardLast4: store.cardLast4, status: 'STARTING'
  };
  setAfeChargeState('validating');
  appState.apiBusy = true;
  appState.apiFlow = { method, index: 0, stage: 'check' };
  appState.page = 'apiStarting'; renderApiFlow();
  try {
    const readiness = await AFEApi.validateFunding({ paymentMethod: method, cardToken: store.cardToken, walletBalance: store.wallet });
    if (!readiness.allowed) { setAfeChargeState('failed'); appState.apiBusy = false; appState.apiFlow = null; appState.page = guest ? 'guest' : 'setup'; render(); showFundingGate(); return; }
    if (!fleet && method === 'card') {
      setAfeChargeState('preauthorizing');
      appState.apiFlow = { method, index: 1, stage: 'preauth' }; renderApiFlow();
      const auth = await AFEApi.peachPreAuthorize({ cardToken: store.cardToken, amount: cap, reference: sessionId, failure: appState.failure });
      active.preauthId = auth.authorizationId;
      active.preauth = auth.authorizedAmount;
      active.preauthStatus = auth.status;
    }
    setAfeChargeState('starting');
    appState.apiFlow = { method, index: method === 'card' && !fleet ? 2 : 1, stage: 'start' }; renderApiFlow();
    const started = await AFEApi.haiderStartCharge({ sessionId, stationId: s.id, connectorId: c.id, chargerCode: appState.guestCode, failure: appState.failure });
    if (started.status !== 'ACCEPTED') throw new Error('Haider did not accept the OCPI start command.');
    setAfeChargeState('awaitingCommandResult');
    appState.apiFlow = { method, index: 3, stage: 'commandResult' }; renderApiFlow();
    const commandResult = await AFEApi.haiderAwaitStartResult({ sessionId, commandId: started.commandId });
    if (commandResult.result !== 'ACCEPTED') throw new Error('Haider did not confirm that charging started.');
    active.haiderCommandId = started.commandId;
    active.haiderSessionId = commandResult.sessionId;
    active.status = 'CHARGING';
    setAfeChargeState('charging');
    appState.active = active;
    setConnectorStatus(c, 'Charging');
    pushNotice('Charging started', `${s.name} · ${c.label}`, `${money(0)} · 0.0 kWh`, active.id);
    toast(afeFlowText('startedToast'));
    appState.apiBusy = false; appState.apiFlow = null;
    startConnectionAnimation();
  } catch (error) {
    if (active.preauthId) {
      setAfeChargeState('voiding');
      try { await AFEApi.peachRelease({ authorizationId: active.preauthId, amount: active.preauth, reference: `${sessionId}-startup-failed` }); } catch {}
    }
    const kind = appState.failure === 'payment' && !active.preauthId ? 'payment' : appState.failure === 'gun' ? 'gun' : 'communication';
    appState.apiBusy = false;
    appState.active = null;
    afeSetFailure(kind);
  }
}
startSession = function startSessionWithApi() { return startAfeCharge({ guest: false }); };
beginGuestConnection = function beginGuestConnectionWithApi() { return startAfeCharge({ guest: true }); };

const startConnectionAnimationAfeBase = startConnectionAnimation;
startConnectionAnimation = function startConnectionAnimationWithHaiderPoll() {
  startConnectionAnimationAfeBase();
  if (appState.haiderPollTimer) clearInterval(appState.haiderPollTimer);
  appState.haiderPollTimer = window.setInterval(() => pollHaiderChargeStatus(), 6500);
};
async function pollHaiderChargeStatus() {
  const active = appState.active;
  if (!active?.haiderSessionId || appState.haiderPollBusy || appState.settlementBusy) return;
  appState.haiderPollBusy = true;
  try {
    const event = await AFEApi.haiderGetChargeStatus({ sessionId: active.haiderSessionId });
    if (event.status === 'COMPLETED' && event.meter) await settleAfeCharge(active, event);
  } catch (error) { console.warn('AFE Charge demo status poll failed', error); }
  finally { appState.haiderPollBusy = false; }
}
function finishSession(reason = 'Stopped by driver') {
  const active = appState.active;
  if (!active || active.stopRequested || appState.settlementBusy) return;
  active.stopRequested = true;
  active.stopReason = reason;
  setAfeChargeState('stopping');
  if (appState.tick) clearInterval(appState.tick);
  appState.page = 'apiStopping'; appState.apiFlow = { stage: 'stop', index: 0 }; renderApiFlow();
  AFEApi.haiderRequestStop({ sessionId: active.haiderSessionId, stationId: active.stationId, connectorId: active.connectorId, energy: active.energy, cost: active.cost, reason })
    .then(() => pollHaiderChargeStatus())
    .catch(error => { active.stopRequested = false; setAfeChargeState('charging'); appState.page = 'live'; renderLive(); toast(error.message || 'Could not stop the demo session'); });
}

async function settleAfeCharge(active, event) {
  if (!active || appState.settlementBusy || appState.active?.id !== active.id) return;
  appState.settlementBusy = true;
  setAfeChargeState('settling');
  appState.pendingChargeEnd = event;
  appState.page = 'settling'; appState.apiFlow = { stage: 'capture', index: 0 }; appState.settlementError = null; renderApiFlow();
  const finalEnergy = Number(event.meter?.energy ?? active.energy) || 0;
  const actual = Number(Math.min(active.cap, Number(event.meter?.cost ?? active.cost) || 0).toFixed(2));
  const preauth = active.payment === 'card' ? Number(active.preauth || 0) : 0;
  const release = Number(Math.max(0, preauth - actual).toFixed(2));
  try {
    let capture = null, releaseResult = null;
    if (active.payment === 'card') {
      if (actual > 0) capture = await AFEApi.peachCapture({ authorizationId: active.preauthId, amount: actual, reference: active.id });
      appState.apiFlow = { stage: 'release', index: 1 }; renderApiFlow();
      if (release > 0) releaseResult = await AFEApi.peachRelease({ authorizationId: active.preauthId, amount: release, reference: active.id });
    } else if (active.payment === 'wallet') {
      store.wallet = Math.max(0, Number((Number(store.wallet) - actual).toFixed(2)));
    }
    const s = station(active.stationId), c = s.connectors.find(item => item.id === active.connectorId), now = Date.now();
    if (c) setConnectorStatus(c, 'Available');
    const rec = {
      ...active, energy: finalEnergy, cost: actual, ended: event.endedAt || now,
      duration: Math.max(1, Math.round(((event.endedAt || now) - active.started) / 60000)), actual, preauth,
      release, reason: event.meter?.reason || active.stopReason || 'Session ended', status: 'Complete',
      transaction: capture?.captureId || `DEMO-TX-${now.toString().slice(-8)}`,
      releaseId: releaseResult?.releaseId || null, stationName: s.name, area: s.area, rate: s.rate,
      connectorLabel: c?.label || active.connectorId, invoice: `AFE-${now.toString().slice(-8)}`,
      paymentStatus: active.payment === 'card' ? 'Captured and released' : active.payment === 'wallet' ? 'Wallet settled' : 'Fleet account recorded'
    };
    delete rec.stopRequested; delete rec.stopReason; delete rec.haiderSessionId;
    store.history.unshift(rec);
    if (active.payment === 'wallet') store.walletLedger.unshift({ id: rec.id, type: 'charge', amount: actual, created: rec.ended, stationName: rec.stationName, energy: rec.energy, recordId: rec.id, demo: true });
    appState.recordId = rec.id; appState.active = null; appState.apiFlow = null; appState.settlementBusy = false; appState.pendingChargeEnd = null;
    setAfeChargeState('completed');
    if (appState.tick) clearInterval(appState.tick);
    if (appState.haiderPollTimer) clearInterval(appState.haiderPollTimer);
    appState.page = 'summary'; saveStore();
    pushNotice('Charging ended', s.name, `${money(actual)} · ${finalEnergy.toFixed(1)} kWh`, rec.id);
    pushNotice('Payment successful', s.name, `${money(actual)} · ${active.payment === 'wallet' ? 'Wallet' : `Visa •••• ${esc(active.cardLast4 || store.cardLast4)}`}`, rec.id);
    pushNotice('Receipt generated', s.name, `Invoice ${rec.invoice}`, rec.id);
    saveStore(); render();
    toast(active.payment === 'card'
      ? afeFlowText('paymentToast', { amount: actual.toFixed(2), last4: active.cardLast4 || store.cardLast4 })
      : active.payment === 'wallet' ? afeFlowText('walletToast', { amount: actual.toFixed(2) }) : afeFlowText('paymentToast', { amount: actual.toFixed(2), last4: '—' }));
  } catch (error) {
    appState.settlementBusy = false;
    appState.settlementError = error?.message || 'Settlement failed';
    appState.page = 'settling'; renderApiFlow();
  }
}
function retryAfeSettlement() {
  const active = appState.active, event = appState.pendingChargeEnd;
  if (active && event) settleAfeCharge(active, event);
}

const openTopUpSheetAfeBase = openTopUpSheet;
openTopUpSheet = function openTopUpSheetWithCardStatus() {
  openTopUpSheetAfeBase();
  if (!afeHasCardToken()) {
    const payment = document.querySelector('.wallet-sheet-payment');
    if (payment) payment.innerHTML = `<span class="virtual-card-mark">ϟ</span><span><small>${esc(afeFlowText('noCard'))}</small><b>${esc(afeFlowText('cardNotBound'))}</b></span><button onclick="showPage('cardForm')">${esc(afeFlowText('bindCard'))}</button>`;
  }
};
async function topUpWallet(amount, bonus = 0) {
  amount = Math.max(0, Number(amount) || 0); bonus = Math.max(0, Number(bonus) || 0);
  if (!amount || appState.topupBusy) return;
  if (!afeHasCardToken()) { appState.pendingTopUp = { amount, bonus }; closeTopUpSheet(); toast(afeFlowText('cardNotBound')); showPage('cardForm'); return; }
  appState.topupBusy = true;
  const root = document.getElementById('overlayRoot');
  if (root) root.innerHTML = `<div class="app-filter"><section class="app-sheet wallet-topup-sheet wallet-processing" role="status"><div class="wallet-sheet-grab"></div><div class="connection-spinner"></div><h2>${esc(afeFlowText('stepPreauth'))}</h2><p class="app-muted">${money(amount)} · ${esc(afeFlowText('demoOnly'))}</p></section></div>`;
  try {
    const payment = await AFEApi.peachWalletTopUp({ cardToken: store.cardToken, amount, reference: `TOP-${Date.now().toString(36)}` });
    const entry = { id: payment.paymentId, type: 'topup', amount, bonus, created: Date.now(), paymentId: payment.paymentId, demo: true };
    store.wallet = Number((Number(store.wallet) + amount + bonus).toFixed(2)); store.walletLedger.unshift(entry); saveStore(); closeTopUpSheet();
    if (appState.page === 'wallet') renderWallet();
    toast(`${afeFlowText('topupSuccess')} · ${money(amount + bonus)}`);
  } catch (error) { closeTopUpSheet(); toast(error.message || 'Demo top-up failed'); }
  finally { appState.topupBusy = false; }
}

const renderAfeBase = render;
render = function renderWithApiStates() {
  if (['apiStarting', 'apiStopping', 'settling'].includes(appState.page)) return renderApiFlow();
  return renderAfeBase();
};
const clearDemoDataAfeBase = clearDemoData;
clearDemoData = function clearDemoDataWithMockCard() {
  if (!confirm('Clear demo sessions, notifications, wallet, mock card token and preferences on this device?')) return;
  try { localStorage.removeItem(AFE_CARD_TOKEN_KEY); localStorage.removeItem(AFE_CARD_LAST4_KEY); } catch {}
  try { localStorage.removeItem(STORE_KEY); } catch {}
  store = loadStore(); store.cardToken = null;
  appState.active = null; appState.page = 'find';
  render(); toast('Demo data cleared');
};

// Expose only non-secret demo metadata for the support/about screen and console.
window.AFEApiInfo = Object.freeze({ mock: AFE_API_MOCK_MODE, protocol: 'OCPI 2.2.1', haiderRole: 'CPO', afeRole: 'eMSP', transitions: AFE_CHARGE_TRANSITIONS, endpoints: { AFE_BASE_URL, HAIDER_BASE_URL, PEACH_BASE_URL }, delayMs: AFE_API_MOCK_DELAY_MS });
