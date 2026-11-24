/* Hardhitter sandbox operator view. The public PWA contains no platform or driver credentials. */
(() => {
  'use strict';
  const commandPages = new Set(['find', 'station', 'setup', 'guest', 'failure', 'apiStarting', 'apiStopping', 'connecting', 'guestConnecting', 'live', 'settling']);
  const savedKey = 'afe.ocpi.recording.v1:' + AFE_BASE_URL;
  const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
  const commands = new Set(['ACCEPTED', 'REJECTED', 'NOT_SUPPORTED', 'UNKNOWN_SESSION']);
  const preflight = new Set(['TARGET_EVSE_NOT_AVAILABLE', 'TARGET_CCS2_CONNECTOR_NOT_CONFIRMED',
    'TARGET_LOCATION_MISSING_OR_AMBIGUOUS', 'TARGET_EVSE_MISSING_OR_AMBIGUOUS', 'OCPI_COMMAND_CONFIGURATION_INCOMPLETE',
    'OCPI_OPERATOR_UNAVAILABLE','DEMO_PREAUTH_REQUIRED','INVALID_COMMAND_TARGET_PAYLOAD_OR_TOKEN',
    'INVALID_APP_USER_TOKEN','COMMAND_OR_SESSION_MODULE_MISSING','UNKNOWN_ATTEMPT']);
  const featured = 'TH43870001000001000100';
  let grant = '', notice = '', grantEditor = false;
  let catalog = null, targets = [], selection = '', refreshing = false, sending = false, checking = false, requestSequence=0;
  let attempt = null;
  try {
    const value = JSON.parse(localStorage.getItem(savedKey) || 'null');
    if (value && uuid.test(value.id) && value.mode === 'live' && value.target?.evse_uid) attempt = value;
  } catch { /* The live branch checks storage before dispatch. */ }

  const tr = (en, zh) => store.language === 'zh' ? zh : en;
  const home = () => commandPages.has(appState.page);
  const when = () => new Date().toISOString();
  const selected = () => targets.find(item => item.key === selection);
  const ccs2 = item => item?.standard === 'IEC_62196_T2_COMBO';
  const eligible = item => catalog?.source === 'cpo' && item?.status === 'AVAILABLE' && ccs2(item);
  function targetIds(item) {
    const {location_id, evse_uid, connector_id} = item;
    const target = {location_id, evse_uid, connector_id};
    if (item.country_code && item.party_id) {
      target.country_code = item.country_code; target.party_id = item.party_id;
    }
    return target;
  }
  const ack = value => commands.has(value) ? value : null;
  function save() {
    if (attempt?.mode === 'live') localStorage.setItem(savedKey, JSON.stringify(attempt));
  }
  function update() { if (home()) paint(); }

  class ApiError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
  }
  async function api(path, {method = 'GET', body, privateRoute = false} = {}) {
    let base;
    try { base = new URL(AFE_BASE_URL); } catch { throw new ApiError(0, 'BACKEND_NOT_CONFIGURED'); }
    if (base.username || base.password || (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)))) {
      throw new ApiError(0, 'BACKEND_NOT_CONFIGURED');
    }
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (privateRoute) {
      if (!grant) throw new ApiError(401, 'OPERATOR_PASS_REQUIRED');
      headers.Authorization = 'Bearer ' + grant;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), method === 'GET' ? 15000 : 30000);
    try {
      const response = await fetch(new URL(path, base), { method, headers, credentials: 'omit', cache: 'no-store',
        redirect: 'error', signal: controller.signal, body: body === undefined ? undefined : JSON.stringify(body) });
      let data;
      try { data = await response.json(); } catch { throw new ApiError(response.status, 'INVALID_BACKEND_RESPONSE'); }
      if (!response.ok) throw new ApiError(response.status,
        typeof data?.error === 'string' && /^[A-Z0-9_]{1,90}$/.test(data.error) ? data.error : 'BACKEND_ERROR');
      return data;
    } finally { clearTimeout(timeout); }
  }
  function explain(error) {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        grant = ''; grantEditor = true;
        return tr('The operator pass is missing, expired, or not valid for this connector.', '测试通行证缺失、已过期或未授权这把枪。');
      }
      return error.code;
    }
    return tr('No response from the backend.', '未收到后端响应。');
  }
  function readCatalog(data, source) {
    if (data?.source !== source || !Array.isArray(data.locations) || !Number.isFinite(Date.parse(data.checkedAt))) throw new Error('Invalid catalog');
    const rows = [];
    const id = value => typeof value === 'string' && value.length > 0 && value.length <= 36;
    for (const location of data.locations) {
      if (!id(location.id) || !Array.isArray(location.evses)) throw new Error('Invalid location');
      for (const evse of location.evses) {
        if (!id(evse.uid) || !Array.isArray(evse.connectors)) throw new Error('Invalid EVSE');
        for (const connector of evse.connectors) {
          if (!id(connector.id)) throw new Error('Invalid connector');
          const item = { location_id: location.id, evse_uid: evse.uid, connector_id: connector.id,
            country_code: location.country_code, party_id: location.party_id,
            name: location.name || location.id, standard: connector.standard, status: evse.status };
          item.key = JSON.stringify([item.country_code, item.party_id, item.location_id, item.evse_uid, item.connector_id]);
          rows.push(item);
        }
      }
    }
    return { data, rows };
  }
  async function loadLocations(force = false) {
    if (refreshing && !force) return;
    const request = ++requestSequence;
    refreshing = true;
    update();
    let result = null;
    try { result = readCatalog(await api('/api/ocpi/locations',{privateRoute:!!grant}), 'cpo'); }
    catch {
      try {
        const response = await fetch('./recording-catalog.json', { cache: 'no-cache' });
        if (response.ok) result = readCatalog(await response.json(), 'snapshot');
      } catch { /* An unavailable snapshot is an empty state. */ }
    }
    if (request !== requestSequence) return;
    catalog = result?.data || null;
    targets = result?.rows || [];
    if (!targets.some(item => item.key === selection)) {
      selection = (targets.find(item => item.evse_uid === featured) || targets[0])?.key || '';
    }
    refreshing = false;
    update();
  }

  function button(action, text, secondary = false, disabled = false) {
    return '<button type="button" class="app-button full' + (secondary ? ' secondary' : '') +
      '" data-afe-command="' + action + '"' + (disabled ? ' disabled' : '') + '>' + esc(text) + '</button>';
  }
  function pair(label, value) {
    return '<div class="rec-pair"><dt>' + esc(label) + '</dt><dd>' + esc(value ?? '—') + '</dd></div>';
  }
  function grantForm() {
    if (grant && !grantEditor) return button('edit-pass', tr('Change operator pass', '更换测试通行证'), true);
    return '<label for="rec-pass">' + tr('Sandbox operator pass','沙盒测试通行证') + '</label>' +
      '<input id="rec-pass" class="app-input" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="256">' +
      button('save-pass', tr('Use pass','使用通行证'), true);
  }
  function inspector(item) {
    if (!item) return '';
    return '<dl class="rec-details">' + pair('Location ID',item.location_id) + pair('EVSE UID',item.evse_uid) +
      pair('Connector ID',item.connector_id) + pair(tr('Connector','接口规格'),item.standard) +
      pair(tr('Published status','平台上报状态'),item.status) + '</dl>';
  }
  function browse() {
    const item = selected();
    const source = catalog?.source === 'cpo' ? tr('Live CPO catalog','海汇德实时目录') :
      catalog ? tr('Saved CPO snapshot · rehearsal only','海汇德历史快照 · 仅限排练') :
      refreshing ? tr('Loading stations…','正在读取场站…') : tr('Station catalog unavailable','场站目录暂不可用');
    const canSend = eligible(item) && !!grant;
    let connectorNote = '';
    if (item && !ccs2(item)) {
      const reported = item.standard || tr('unknown','未提供');
      connectorNote = item.evse_uid === featured ? tr('Gun A is physically CCS2. The platform reports ' + reported + '. Awaiting Hardhitter confirmation.',
        '现场 A 枪为 CCS2，平台规格为 ' + reported + '，待海汇德核对。') :
        tr('Remote start requires a confirmed CCS2 connector. The platform reports ' + reported + '.', '远程启动需要平台确认 CCS2 枪口，当前上报规格为 ' + reported + '。');
    }
    const picker = targets.length ? '<label for="rec-gun">' + tr('Station and connector','场站及枪口') +
      '</label><select id="rec-gun" class="app-select">' + targets.map((r,i) =>
      '<option value="' + i + '"' + (selection === r.key ? ' selected' : '') + '>' +
      esc(r.name + ' · ' + r.evse_uid + ' / ' + r.connector_id) + '</option>').join('') + '</select>' : '';
    return '<div class="rec-heading"><div><p class="app-small">HARDHITTER · OCPI 2.2.1</p><h1>' +
      tr('Charging stations','充电场站') + '</h1></div><button type="button" class="rec-refresh" data-afe-command="refresh"' +
      (refreshing ? ' disabled' : '') + '>' + tr('Refresh','刷新') + '</button></div>' +
      '<section class="app-card rec-card"><p class="rec-source">' + esc(source) + '</p>' +
      (catalog ? '<p class="rec-time">' + esc(catalog.checkedAt) + '</p>' : '') + picker + inspector(item) +
      (connectorNote ? '<p class="app-notice">' + esc(connectorNote) + '</p>' : '') + '</section>' +
      '<section class="app-card rec-card"><h2>' + tr('Sandbox charging test','沙盒充电测试') + '</h2><p>' +
      tr('Demo payment reserves R200 in the test record. A live start can energise the selected connector.',
        '演示支付在测试记录中登记 R200。远程启动会向所选实桩发出指令。') + '</p>' +
      grantForm() + button('live', tr('Demo payment & remote start','演示支付并远程启动'), false, !canSend || refreshing || sending) +
      (item && item.status !== 'AVAILABLE' ? '<p>' + tr('Remote start requires a published AVAILABLE connector.','远程启动需要平台将该枪上报为 AVAILABLE。') + '</p>' : '') +
      button('rehearse',tr('Rehearse start & stop','排练启动和停止'),true,!item || sending) + '</section>';
  }
  function isClosed(a) {
    return a.closed || a.session?.status === 'COMPLETED' || a.session?.status === 'INVALID' ||
      (a.session?.status !== 'ACTIVE' && (['REJECTED','NOT_SUPPORTED','UNKNOWN_SESSION'].includes(a.startAck) ||
      ['FAILED','REJECTED','NOT_SUPPORTED','EVSE_OCCUPIED','EVSE_INOPERATIVE','TIMEOUT'].includes(a.startResult)));
  }
  function current() {
    const a = attempt, rehearsal = a.mode === 'rehearsal', closed = isClosed(a);
    const live = a.session?.state === 'MATCHED' && a.session.status === 'ACTIVE';
    const recent = a.checkedAt && Date.now() - Date.parse(a.checkedAt) < 30_000;
    const stateLabel = a.phase === 'preauth' ? tr('Recording demo payment','登记演示支付') :
      rehearsal ? closed ? tr('Rehearsal complete','排练已结束') : tr('Rehearsal in progress','充电流程排练中') :
      closed ? (a.session?.status === 'COMPLETED' ? tr('Session completed','会话已结束') : tr('Start did not complete','启动未完成')) :
      a.stopSubmitted ? tr('Checking stop result','正在核对停止结果') :
      live ? (recent ? tr('Charging','正在充电') : tr('Last reported active','上次上报为充电中')) : tr('Connecting to charger','正在连接充电桩');
    const noCommand = tr('Not sent · rehearsal','未下发 · 排练');
    const noAck = tr('Awaiting receipt','尚未取得回执');
    const meter = a.meterSince ? '<section class="app-card app-recommend rec-hero"><div class="app-row"><strong>' +
      tr('Simulated meter','模拟电表') + '</strong><span class="rec-receipt">OCPI · ' + esc(rehearsal ? noCommand : a.startAck || noAck) +
      '</span></div><p class="rec-energy"><strong data-meter-energy></strong> kWh</p><div class="rec-metrics"><div><span>' +
      tr('Power','功率') + '</span><b><span data-meter-power></span> kW</b></div><div><span>' +
      tr('Elapsed','时长') + '</span><b data-meter-time></b></div></div></section>' : '';
    const statusRows = rehearsal ? pair('OCPI · START_SESSION',noCommand) + pair('OCPI · STOP_SESSION',noCommand) :
      pair('OCPI · START_SESSION',a.startAck || (a.notDispatched ? tr('Not dispatched','未下发') : noAck)) +
      pair(tr('Start callback','启动回调'),a.startResult) + (a.sentAt ? pair(tr('Phone request · UTC','手机请求 · UTC'),a.sentAt) : '') +
      pair(tr('CPO session','海汇德会话'),a.session?.status || a.session?.state) +
      (a.checkedAt ? pair(tr('Last checked · UTC','会话查询 · UTC'),a.checkedAt) : '') +
      (a.stopSubmitted || a.stopAck ? pair('OCPI · STOP_SESSION',a.stopAck || noAck) + pair(tr('Stop callback','停止回调'),a.stopResult) : '') +
      (a.id ? pair(tr('Attempt ID','测试编号'),a.id) : '');
    return '<p class="rec-source">' + (rehearsal ? tr('Rehearsal · no charger commands','排练模式 · 不下发充电指令') :
      tr('Live OCPI sandbox','OCPI 真实沙盒接口')) + '</p><h1>' + stateLabel + '</h1><p class="rec-target">' +
      esc(a.target.name || a.target.location_id) + ' · ' + esc(a.target.evse_uid) + '</p>' + meter +
      '<section class="app-card rec-card"><h2>' + tr('Session details','会话详情') + '</h2><dl class="rec-details">' +
      pair(tr('Station data','场站数据'), a.catalogSource === 'snapshot' ? tr('CPO snapshot','海汇德历史快照') : tr('CPO catalog','海汇德场站接口')) +
      pair(tr('Demo payment','演示支付'), a.payment === 'backend' ? (a.amountLabel ? a.amountLabel+' · ' : '') + 'DEMO_AUTHORIZED' :
        a.payment === 'local' ? tr('R200 · local simulation','R200 · 本机模拟') : tr('Pending','待确认')) +
      (a.proof && rehearsal ? pair(tr('Demo receipt','演示凭证'),a.proof) : '') +
      statusRows + '</dl></section>' +
      (!rehearsal && !closed && (!grant || grantEditor) ? '<section class="app-card rec-card">' + grantForm() + '</section>' : '') +
      (a.phase !== 'preauth' && !closed && (rehearsal || live) ? button('stop', rehearsal ? tr('Stop rehearsal','结束充电排练') :
        tr('Stop this charging session','停止本次实际充电'), false, sending || a.stopSubmitted || (!rehearsal && !grant)) : '') +
      (!rehearsal && a.id && !closed ? button('status',tr('Refresh command status','刷新命令状态'),true,!grant || sending) : '') +
      (closed ? button('finish',tr('Back to stations','返回场站'),true) : '');
  }
  function paint() {
    const scrollTop = document.getElementById('afe-recording')?.closest('.app-main')?.scrollTop || 0;
    shell('<div id="afe-recording" class="afe-recording"></div>');
    const root = document.getElementById('afe-recording');
    root.lang = store.language === 'zh' ? 'zh-CN' : 'en';
    root.innerHTML = (attempt ? current() : browse()) + (notice ? '<p class="app-notice rec-error" role="status">' + esc(notice) + '</p>' : '');
    if (scrollTop) root.closest('.app-main').scrollTop = scrollTop;
    updateMeter();
  }
  function updateMeter() {
    if (!attempt?.meterSince) return;
    const elapsed = Math.max(0,(attempt.ended || Date.now()) - attempt.meterSince) / 1000;
    const power = document.querySelector('[data-meter-power]'), energy = document.querySelector('[data-meter-energy]');
    const duration = document.querySelector('[data-meter-time]');
    if (power) power.textContent = isClosed(attempt) ? '0.0' : (36 + 2 * Math.sin(elapsed / 6)).toFixed(1);
    if (energy) energy.textContent = (elapsed * 36 / 3600).toFixed(3);
    if (duration) duration.textContent = formatDuration(elapsed * 1000);
  }
  function rememberPayment(result) {
    const modeMatches = attempt.mode === 'rehearsal' ? result?.mode === 'rehearsal' :
      result?.paymentMode === 'demo' && (result.mode == null || result.mode === 'live');
    if (result?.status !== 'DEMO_AUTHORIZED' || !uuid.test(result.attemptId) || !modeMatches ||
      result.currency !== 'ZAR' || !(result.amount === '200.00' || result.amount === 200)) {
      throw new ApiError(502, 'INVALID_DEMO_PAYMENT_RECEIPT');
    }
    attempt.payment = 'backend';
    attempt.amountLabel = 'R' + Number(result.amount).toFixed(2);
    attempt.proof = result.attemptId;
  }
  async function start(mode) {
    const target = selected();
    if (sending || attempt || !target || (mode === 'live' && (!grant || !eligible(target) || refreshing))) return;
    notice = ''; sending = true;
    attempt = { mode, phase:'preauth', target, catalogSource:catalog?.source, startAck:null, stopAck:null };
    update();
    try {
      if (mode === 'rehearsal') {
        try {
          const result = await api('/api/demo/rehearsal-preauthorize',{method:'POST',body:{}});
          rememberPayment(result);
        } catch { attempt.payment = 'local'; }
        attempt.phase = 'meter'; attempt.meterSince = Date.now();
        return;
      }
      const result = await api('/api/demo/preauthorize',{method:'POST',privateRoute:true,body:targetIds(target)});
      rememberPayment(result); attempt.id = result.attemptId; attempt.phase = 'connecting';
      save(); // If this fails the physical command must not be sent.
      attempt.sentAt = when(); save(); update();
      const resultAck = await api('/api/ocpi/start-session',{method:'POST',privateRoute:true,
        body:{attemptId:attempt.id,...targetIds(target)}});
      if (resultAck.attemptId !== attempt.id || !ack(resultAck.ack)) throw new Error();
      attempt.startAck = resultAck.ack;
      save();
    } catch (error) {
      notice = explain(error);
      if (!attempt.sentAt) {
        attempt = null;
      } else if (preflight.has(error.code) || [400,401,403,413].includes(error.status)) {
        attempt.closed = true; attempt.notDispatched = true;
      } else {
        notice += ' · ' + tr('Check the same attempt for its receipt.','请查询同一测试编号的回执。');
      }
      try { save(); } catch { /* Keep the visible attempt until it is reconciled. */ }
    } finally {
      sending = false; update();
    }
    if (attempt?.mode === 'live' && !isClosed(attempt)) await status();
  }
  async function status() {
    const a = attempt;
    if (!a?.id || a.mode !== 'live' || checking || sending || !grant || isClosed(a)) return;
    checking = true;
    try {
      const result = await api('/api/ocpi/session-status?attemptId=' + encodeURIComponent(a.id),{privateRoute:true});
      if (attempt !== a) return;
      if (result.attemptId !== a.id) throw new ApiError(409,'ATTEMPT_MISMATCH');
      a.startAck = ack(result.start?.ack) || a.startAck;
      a.startResult = result.start?.callback || a.startResult;
      a.stopAck = ack(result.stop?.ack) || a.stopAck;
      a.stopResult = result.stop?.callback || a.stopResult;
      if (result.session) a.session = result.session;
      a.checkedAt = when();
      if (a.session?.state === 'MATCHED' && a.session.status === 'ACTIVE' && !a.meterSince) a.meterSince = Date.now();
      if (isClosed(a) && !a.ended) a.ended = Date.now();
      notice = ''; save();
    } catch (error) {
      if (attempt === a) notice = explain(error);
    } finally {
      checking = false;
      if (document.activeElement?.id !== 'rec-pass') update();
    }
  }
  async function stop() {
    if (!attempt || isClosed(attempt) || sending || attempt.stopSubmitted) return;
    if (attempt.mode === 'rehearsal') {
      attempt.ended = Date.now(); attempt.closed = true; update(); return;
    }
    if (!grant || attempt.session?.state !== 'MATCHED' || attempt.session.status !== 'ACTIVE') return;
    sending = true; notice = ''; attempt.stopSubmitted = true;
    try {
      save(); update();
      const receipt = await api('/api/ocpi/stop-session',{method:'POST',privateRoute:true,body:{attemptId:attempt.id}});
      if (receipt.attemptId !== attempt.id || !ack(receipt.ack)) throw new Error();
      attempt.stopAck = receipt.ack; save();
    } catch (error) {
      notice = explain(error);
      if ([400,401,403,413].includes(error.status) || preflight.has(error.code) || error.code === 'NO_UNIQUE_MATCHING_ACTIVE_SESSION') {
        attempt.stopSubmitted = false;
      } else {
        notice += ' · ' + tr('Stop delivery is uncertain. Check the station and refresh status.','停止命令回执待确认，请查看现场并刷新状态。');
      }
      try { save(); } catch { /* The stored attempt ID remains available for recovery. */ }
    } finally { sending = false; update(); }
  }
  document.addEventListener('change',event => {
    if (event.target.id !== 'rec-gun' || attempt) return;
    selection = targets[Number(event.target.value)]?.key || ''; notice = ''; update();
  });
  document.addEventListener('click',event => {
    const control = event.target.closest?.('[data-afe-command]');
    if (!control || control.disabled) return;
    switch (control.dataset.afeCommand) {
      case 'refresh': notice=''; void loadLocations(); break;
      case 'edit-pass': grantEditor = true; update(); break;
      case 'save-pass': {
        const value = document.getElementById('rec-pass')?.value.trim();
        if (!value || /\s/.test(value)) { notice=tr('Enter your operator pass.','请输入测试通行证。'); update(); break; }
        grant=value; grantEditor=false; notice=''; update();
        if (attempt) void status(); else void loadLocations(true);
        break;
      }
      case 'live': void start('live'); break;
      case 'rehearse': void start('rehearsal'); break;
      case 'stop': void stop(); break;
      case 'status': void status(); break;
      case 'finish':
        if (!attempt || !isClosed(attempt)) break;
        if (attempt.mode === 'live') localStorage.removeItem(savedKey);
        attempt=null; notice=''; update(); void loadLocations(); break;
    }
  });

  const previousRender = render;
  render = function renderWithRecording() { return home() ? paint() : previousRender(); };
  startSession = beginGuestConnection = () => showPage('find');
  handleScannedChargerCode = function matchPublishedGun(value) {
    const code = normalizeQrValue(value);
    const matches = targets.filter(item => item.evse_uid === code || item.connector_id === code);
    if (matches.length !== 1 || attempt) {
      stopCameraScan(); setScanStatus(tr('Select the exact connector from the station catalog.','请从场站目录选择准确的枪口。')); return;
    }
    selection=matches[0].key; stopCameraScan(); showPage('find');
  };
  setInterval(() => { if (home()) updateMeter(); },1000);
  setInterval(() => { if (home() && !document.hidden) void status(); },5000);
  window.addEventListener('focus', () => { if (attempt && home()) void status(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && attempt && home()) void status(); });
  render();
  void loadLocations();
})();
