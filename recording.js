/* Real Hardhitter / Peach charging workflow for Safari and installed iPhone web apps. */
(() => {
  'use strict';
  const root = document.getElementById('live-charge');
  const langButton = document.getElementById('afe-language');
  const attemptPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const passPattern = /^[A-Za-z0-9_-]{43}$/;
  const declined = ['REJECTED','FAILED','NOT_SUPPORTED','UNKNOWN_SESSION','EVSE_OCCUPIED','EVSE_INOPERATIVE','TIMEOUT'];
  const idFields = ['country_code','party_id','location_id','evse_uid','connector_id'];
  let chinese = navigator.language.toLowerCase().startsWith('zh');
  try { const saved = localStorage.getItem('afe.live.language'); if (saved) chinese = saved === 'zh'; } catch {}
  let locations = [], sourceTime = '', stationKey = '', connectorKey = '';
  let loading = false, catalogError = '', fetching = 0, operatorPass = '', busy = false, checking = false, message = '';
  let active = null;
  const tr = (en, zh) => chinese ? zh : en;
  function esc(input) {
    return String(input ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function button(action,label,{disabled = false,secondary = false} = {}) {
    return '<button class="app-button full' + (secondary ? ' secondary' : '') + '" type="button" data-act="' + action + '"' +
      (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }
  function pair(label, value) {
    if (value == null || value === '') return '';
    return '<div class="rec-pair"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }
  function textError(error) {
    return error instanceof ChargeApiError ? error.code : tr('Could not reach the charging service.', '暂时无法连接充电服务。');
  }
  const keyFor = (site) => JSON.stringify([site.country_code,site.party_id,site.id]);
  const selectedSite = () => locations.find(s => keyFor(s) === stationKey);
  function connectors(site) {
    if (!site) return [];
    return site.evses.flatMap(e => e.connectors.map(c => ({
      country_code:site.country_code, party_id:site.party_id, location_id:site.id, evse_uid:e.uid,
      connector_id:c.id, standard:c.standard, status:e.status
    })));
  }
  const keyForGun = (gun) => JSON.stringify(idFields.map(k=>gun[k]));
  const selectedGun = () => connectors(selectedSite()).find(g=>keyForGun(g)===connectorKey);
  const targetOf = gun => Object.fromEntries(idFields.map(k=>[k,gun[k]]));
  const eligible = gun => !!gun && gun.standard === 'IEC_62196_T2_COMBO' && gun.status === 'AVAILABLE';
  function chooseSite(site) {
    stationKey = site ? keyFor(site) : '';
    const guns = connectors(site);
    if (!guns.some(g=>keyForGun(g) === connectorKey)) {
      const first = guns.find(eligible) || guns.find(g=>g.standard==='IEC_62196_T2_COMBO') || guns[0];
      connectorKey = first ? keyForGun(first) : '';
    }
  }

  async function refreshSites() {
    const sequence = ++fetching;
    loading = true; catalogError=''; render();
    try {
      const data = await AFEApi.stations(operatorPass);
      if (sequence !== fetching) return;
      if (data?.source !== 'cpo' || !Array.isArray(data.locations) || !Number.isFinite(Date.parse(data.checkedAt))) {
        throw new ChargeApiError(502,'INVALID_CPO_CATALOG');
      }
      const id = s => typeof s === 'string' && s.length > 0 && s.length <= 36;
      for (const s of data.locations) {
        if (!id(s.id) || !id(s.country_code) || !id(s.party_id) || !Array.isArray(s.evses) ||
            s.evses.some(e=>!id(e.uid) || !Array.isArray(e.connectors) || e.connectors.some(c=>!id(c.id)))) {
          throw new ChargeApiError(502,'INVALID_CPO_CATALOG');
        }
      }
      locations = data.locations; sourceTime = data.checkedAt;
      chooseSite(selectedSite() || locations.find(s=>s.id==='ZA41020001000001') || locations[0]);
    } catch (error) {
      if (sequence !== fetching) return;
      locations=[]; sourceTime=''; chooseSite(null); catalogError=textError(error);
    } finally {
      if (sequence === fetching) { loading=false; render(); }
    }
  }
  function statusLabel(raw) {
    switch (raw) {
      case 'UNKNOWN': return tr('Standby / unknown','待机/未知');
      case 'AVAILABLE': return tr('Available','可用');
      case 'CHARGING': return tr('Charging','充电中');
      case 'INOPERATIVE': return tr('Inoperative','不可用');
      case 'OUTOFORDER': return tr('Out of order','故障');
      case 'RESERVED': return tr('Reserved','已预约');
      default: return raw || tr('Not reported','未上报');
    }
  }
  function coordinate(value, limit) {
    if (!['number','string'].includes(typeof value) || String(value).trim()==='') return null;
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n)<=limit ? n : null;
  }
  function map(site) {
    const lat = coordinate(site.coordinates?.latitude,90), lon = coordinate(site.coordinates?.longitude,180);
    if (lat === null || lon === null) return '<p class="rec-time">'+tr('Coordinates have not been published.','海汇德尚未发布本站坐标。')+'</p>';
    const src = new URL('https://www.openstreetmap.org/export/embed.html');
    src.searchParams.set('bbox',[Math.max(-180,lon-.014),Math.max(-90,lat-.008),Math.min(180,lon+.014),Math.min(90,lat+.008)].join(','));
    src.searchParams.set('marker',lat+','+lon); src.searchParams.set('layer','mapnik');
    return '<iframe class="rec-map" loading="lazy" referrerpolicy="no-referrer" title="'+esc(tr('Station map','场站地图'))+'" src="'+esc(src.href)+'"></iframe>';
  }
  function permissions() {
    return '<details'+(operatorPass ? '' : ' open')+'><summary>'+tr('Sandbox operator pass','沙盒测试通行证')+'</summary>'+
      '<p class="rec-time">'+tr('Use the connector-specific pass issued by the AFE test operator.','请使用 AFE 联调负责人为这把枪签发的通行证。')+'</p>'+
      '<label for="operator-pass">'+tr('Operator pass','测试通行证')+'</label>'+
      '<input id="operator-pass" class="app-input" type="password" maxlength="43" autocomplete="off" autocapitalize="none" spellcheck="false">' +
      button('apply-pass',operatorPass ? tr('Change pass','更换通行证') : tr('Use pass','使用通行证'),{secondary:true})+'</details>';
  }
  function browse() {
    const site=selectedSite(), gun=selectedGun(), guns=connectors(site);
    const title='<div class="rec-heading"><div><p class="app-small">HARDHITTER · OCPI</p><h1>'+
      tr('Charging stations','充电场站')+'</h1></div><button class="rec-refresh" data-act="refresh" type="button"'+(loading?' disabled':'')+'>'+
      tr('Refresh','刷新')+'</button></div>';
    let catalog = '';
    if (catalogError) {
      catalog='<p class="app-notice rec-error" role="status">'+tr('Live station feed unavailable','实时场站暂不可用')+' · '+esc(catalogError)+'</p>';
    } else if (!site) {
      catalog='<p class="app-card">'+(loading?tr('Loading stations…','正在读取场站…'):tr('No stations are visible to this account.','当前账号没有可见场站。'))+'</p>';
    } else {
      const list=locations.map((s,i)=>'<button class="rec-station" type="button" data-site="'+i+'" aria-pressed="'+(s===site)+'"><strong>'+
        esc(s.name || s.id)+'</strong><span>'+esc([s.address,s.city].filter(Boolean).join(', ') || s.id)+'</span></button>').join('');
      const options=guns.map((g,i)=>'<option value="'+i+'"'+(keyForGun(g)===connectorKey?' selected':'')+'>'+
        esc(g.connector_id+' · '+(g.standard==='IEC_62196_T2_COMBO'?'CCS2':g.standard || '—')+' · '+statusLabel(g.status))+'</option>').join('');
      catalog='<section class="app-card rec-card"><div class="app-row"><h2>'+tr('Stations','场站列表')+'</h2><span class="rec-time">'+locations.length+'</span></div>'+
        '<div class="rec-sites">'+list+'</div>'+map(site)+'<p class="rec-time">'+tr('CPO catalog · UTC ','海汇德目录 · UTC ')+esc(sourceTime)+'</p></section>'+
        '<section class="app-card rec-card"><h2>'+esc(site.name || site.id)+'</h2>'+
        (guns.length?'<div class="rec-picker"><label for="connector">'+tr('Select connector','选择枪口')+'</label><select id="connector" class="app-select">'+options+'</select></div>':'')+
        '<dl class="rec-details">'+pair('Location ID',site.id)+pair('EVSE UID',gun?.evse_uid)+pair('Connector ID',gun?.connector_id)+
        pair(tr('CPO status','平台状态'),gun && statusLabel(gun.status))+'</dl></section>';
    }
    let reason='';
    if (gun && !eligible(gun)) reason=gun.standard!=='IEC_62196_T2_COMBO'?tr('The CPO has not identified this connector as CCS2.','海汇德尚未将这把枪标为 CCS2。'):
      tr('The CPO must report this connector as available before checkout.','平台上报枪口可用后可进行预授权。');
    return title+catalog+'<section class="app-card rec-card"><h2>'+tr('Start charging','启动充电')+'</h2>'+
      '<p>'+tr('Peach Payments will request a R200.00 sandbox preauthorisation before remote start.','Peach Payments 将在远程启动前预授权 R200.00（测试环境）。')+'</p>'+
      permissions()+(reason?'<p class="rec-alert">'+esc(reason)+'</p>':'')+
      button('checkout',tr('Start · Open Peach Checkout','启动 · 前往 Peach 收银台'),{disabled:loading || busy || !eligible(gun) || !operatorPass})+'</section>';
  }
  const goodAck = value => ['ACCEPTED','REJECTED','NOT_SUPPORTED','UNKNOWN_SESSION'].includes(value);
  function isActive(a) { return a.session?.state === 'MATCHED' && a.session.status === 'ACTIVE'; }
  function ended(a) {
    return a.session?.state === 'MATCHED' && ['COMPLETED','INVALID'].includes(a.session.status) ||
      !isActive(a) && (declined.includes(a.start?.ack) || declined.includes(a.start?.callback));
  }
  function current() {
    const a = active, matched = a.session?.state==='MATCHED', fresh = Date.now()-Date.parse(a.checkedAt)<30000;
    let title;
    if (matched && a.session.status==='COMPLETED') title=tr('Charging ended','充电已结束');
    else if (ended(a) || a.blockedBeforeStart) title=tr('Charging did not start','充电未启动');
    else if (isActive(a) && a.stopRequested) title=tr('Checking stop result','正在核对停止结果');
    else if (isActive(a)) title=fresh?tr('Charging','正在充电'):tr('Last reported charging','上次上报为充电中');
    else if (a.startRequested || a.start) title=tr('Connecting to charger','正在连接充电桩');
    else if (a.paymentStatus==='UNCONFIRMED') title=tr('Peach result unconfirmed','Peach 预授权结果待核实');
    else if (a.terminalPayment) title=tr('Preauthorisation unsuccessful','预授权未成功');
    else if (a.checkoutCreating) title=tr('Opening Peach Checkout','正在打开 Peach 收银台');
    else title=tr('Verifying Peach preauthorisation','正在核实 Peach 预授权');
    const target=a.target || {};
    const details=pair('Location ID',target.location_id)+pair('EVSE UID',target.evse_uid)+pair('Connector ID',target.connector_id)+
      pair(tr('Peach preauthorisation','Peach 预授权'),a.paymentStatus)+pair(tr('Order reference','订单编号'),a.reference)+
      pair('OCPI · START_SESSION',a.start?.ack)+pair(tr('Start acknowledgement · UTC','启动回执 · UTC'),a.start?.acknowledgedAt)+
      pair(tr('Start callback','启动回调'),a.start?.callback)+pair(tr('Start callback · UTC','启动回调 · UTC'),a.start?.callbackAt)+
      pair('OCPI · STOP_SESSION',a.stop?.ack)+pair(tr('Stop acknowledgement · UTC','停止回执 · UTC'),a.stop?.acknowledgedAt)+
      pair(tr('Stop callback','停止回调'),a.stop?.callback)+pair(tr('CPO session','海汇德会话'),a.session?.status || a.session?.state)+
      pair(tr('Session ID','会话编号'),a.session?.id)+pair(tr('Test attempt','测试编号'),a.id)+pair(tr('Checked · UTC','查询 · UTC'),a.checkedAt);
    const kwh = matched && typeof a.session.kwh==='number' && Number.isFinite(a.session.kwh) && a.session.kwh>=0 ? a.session.kwh : null;
    return '<p class="rec-source">Peach Payments · Hardhitter</p><h1>'+title+'</h1>'+
      (matched?'<section class="app-card app-recommend rec-hero"><h2>'+tr('Energy delivered','已充电量')+'</h2><p>'+
        (kwh===null?tr('Awaiting meter reading','待海汇德上报电量'):'<strong>'+esc(kwh)+'</strong> kWh')+'</p></section>':'')+
      '<section class="app-card rec-card"><h2>'+tr('Transaction details','交易详情')+'</h2><dl class="rec-details">'+details+'</dl></section>'+
      (!a.checkoutCreating && !flowPass ? '<section class="app-card rec-card"><p>'+tr('Enter the original operator pass to resume this attempt.','输入原测试通行证即可恢复本次测试。')+'</p>'+permissions()+'</section>':'')+
      (isActive(a)?button('stop',tr('Stop this session','停止本次充电'),{disabled:busy || a.stopRequested || !flowPass}):'')+
      (!a.checkoutCreating?button('check',tr('Refresh status','刷新状态'),{secondary:true,disabled:busy || checking || !flowPass}):'')+
      (canLeave(a)?button('back',tr('Back to stations','返回场站'),{secondary:true}):'');
  }
  function canLeave(a) {
    return ended(a) || a.terminalPayment || a.blockedBeforeStart || (!a.startRequested && (!flowPass || a.paymentStatus==='PENDING'));
  }
  function render() {
    const scroll=root.scrollTop;
    document.documentElement.lang=chinese?'zh-CN':'en';
    langButton.textContent=chinese?'English':'中文';
    root.setAttribute('aria-busy',String(loading || busy));
    root.innerHTML=(active ? current() : browse())+(message?'<p class="app-notice rec-error" role="status">'+esc(message)+'</p>':'');
    root.scrollTop=scroll;
  }
  const storageKey='afe.sandbox.peach.v1.'+AFE_BASE_URL;
  let flowPass='';
  function remember() {
    if (!active?.id) return;
    try {
      localStorage.setItem(storageKey,JSON.stringify({id:active.id, startRequested:!!active.startRequested,
        stopRequested:!!active.stopRequested, blockedBeforeStart:!!active.blockedBeforeStart,
        reference:active.reference,target:active.target,paymentStatus:active.paymentStatus}));
    } catch { /* The signed return also carries an independent payment handoff. */ }
  }
  function forget() {
    try { localStorage.removeItem(storageKey); sessionStorage.removeItem(storageKey); } catch {}
    active=null; flowPass=''; message=''; render(); void refreshSites();
  }
  function resume() {
    let saved;
    try { saved=JSON.parse(localStorage.getItem(storageKey)); } catch {}
    if (saved && !attemptPattern.test(saved.id)) saved=null;
    const url=new URL(location.href), args=new URLSearchParams(url.hash.slice(1));
    if (args.has('afe_return') || args.has('attempt')) {
      const pass=args.get('afe_return'), id=args.get('attempt');
      // Erase the secret before rendering, making API calls, or adding a map.
      history.replaceState(null,'',url.pathname+url.search);
      if (!passPattern.test(pass || '') || !attemptPattern.test(id || '')) {
        message=tr('Invalid payment return. Reopen the test with your operator pass.','支付返回链接无效，请使用原通行证恢复测试。');
      } else {
        active={...(saved?.id===id ? saved : {}),id}; flowPass=pass; remember();
        try { sessionStorage.setItem(storageKey,JSON.stringify({id,pass})); } catch {}
        return;
      }
    }
    if (saved) {
      active={...saved};
      try {
        const scoped=JSON.parse(sessionStorage.getItem(storageKey));
        if (scoped?.id===saved.id && passPattern.test(scoped.pass)) flowPass=scoped.pass;
      } catch {}
    }
  }
  async function checkout() {
    const gun=selectedGun();
    if (busy || active || !operatorPass || loading || !eligible(gun)) return;
    busy=true; message=''; active={checkoutCreating:true,target:targetOf(gun)}; render();
    try {
      const result=await AFEApi.checkout(operatorPass,active.target);
      if (!attemptPattern.test(result.attemptId) || result.status!=='CHECKOUT_CREATED' || typeof result.reference !== 'string') {
        throw new ChargeApiError(502,'INVALID_CHECKOUT_RESPONSE');
      }
      const dest=new URL(result.redirect_url);
      if (dest.origin!=='https://testsecure.peachpayments.com' || dest.username || dest.password || dest.hash) {
        throw new ChargeApiError(502,'INVALID_CHECKOUT_REDIRECT');
      }
      active={id:result.attemptId,reference:result.reference,target:active.target,paymentStatus:'CHECKOUT_CREATED'};
      flowPass=operatorPass; remember();
      location.assign(dest.href);
    } catch (error) {
      active=null; message=textError(error);
    } finally { busy=false; render(); }
  }
  const notSent = ['TARGET_EVSE_NOT_AVAILABLE','TARGET_CCS2_CONNECTOR_NOT_CONFIRMED','TARGET_LOCATION_MISSING_OR_AMBIGUOUS',
    'TARGET_EVSE_MISSING_OR_AMBIGUOUS','OCPI_COMMAND_CONFIGURATION_INCOMPLETE','RECORDING_DRIVER_MISMATCH','TARGET_NOT_GRANTED'];
  async function submitStart(a) {
    a.startRequested=true; remember(); render();
    try {
      const result=await AFEApi.start(flowPass,a.id,a.target);
      if (result.attemptId!==a.id || !goodAck(result.ack)) throw new ChargeApiError(502,'ACK_UNCONFIRMED');
      a.start={ack:result.ack,acknowledgedAt:result.acknowledgedAt};
    } catch (error) {
      if (notSent.includes(error.code)) {
        a.blockedBeforeStart=true; a.startRequested=false; remember();
      }
      message=textError(error);
    }
  }
  async function readCommandStatus(a) {
    let report;
    try { report=await AFEApi.status(flowPass,a.id); }
    catch (error) { if (error.code==='UNKNOWN_ATTEMPT') return false; throw error; }
    if (a!==active) return false;
    if (report?.attemptId!==a.id || !report.start) throw new ChargeApiError(502,'INVALID_COMMAND_STATUS');
    a.start=report.start; a.stop=report.stop || a.stop; a.session=report.session;
    a.checkedAt=report.checkedAt || new Date().toISOString();
    a.startRequested=true;
    if (a.stop) a.stopRequested=true;
    remember();
    return true;
  }
  async function sync() {
    const a=active;
    if (!a?.id || busy || checking || !flowPass) return;
    checking=true; message='';
    try {
      // Once a start may have reached the CPO, status and stop must keep working
      // even if the payment provider or its original authorisation is unavailable.
      if (a.startRequested && await readCommandStatus(a)) return;
      if (a!==active) return;
      const payment=await AFEApi.payment(flowPass,a.id);
      if (a!==active) return;
      if (payment.attemptId!==a.id || payment.paymentMode!=='peach_sandbox' || payment.amount!=='200.00' ||
          payment.currency!=='ZAR' || !['AUTHORIZED','PENDING','DECLINED','UNCONFIRMED'].includes(payment.status) ||
          !idFields.every(k=>typeof payment.target?.[k]==='string' && payment.target[k].length>0)) {
        throw new ChargeApiError(502,'INVALID_PAYMENT_STATUS');
      }
      a.paymentStatus=payment.status; a.reference=payment.reference; a.target=targetOf(payment.target);
      a.terminalPayment=['DECLINED','UNCONFIRMED'].includes(payment.status);
      remember();
      if (payment.status!=='AUTHORIZED') return;
      if (await readCommandStatus(a)) return;
      if (a!==active) return;
      if (!a.startRequested && !a.blockedBeforeStart) {
        await submitStart(a);
      } else if (!a.blockedBeforeStart) {
        message=tr('The start request has no confirmed receipt. Refresh to check this attempt.','启动请求尚无确认回执，请刷新查询本次测试。');
      }
    } catch (error) {
      message=textError(error);
      if (error.status===401 || error.status===403) { flowPass=''; }
    } finally { checking=false; render(); }
  }
  async function stop() {
    const a=active;
    if (busy || !flowPass || !a || !isActive(a) || a.stopRequested) return;
    busy=true; message=''; a.stopRequested=true; remember(); render();
    try {
      const result=await AFEApi.stop(flowPass,a.id);
      if (result.attemptId!==a.id || !goodAck(result.ack)) throw new ChargeApiError(502,'STOP_ACK_UNCONFIRMED');
      a.stop={ack:result.ack,acknowledgedAt:result.acknowledgedAt};
    } catch (error) {
      message=textError(error);
      if (error.code==='NO_UNIQUE_MATCHING_ACTIVE_SESSION' || error.status===401 || error.status===403) {
        a.stopRequested=false; remember();
        if (error.status===401 || error.status===403) flowPass='';
      }
    } finally { busy=false; render(); }
  }
  root.addEventListener('change', event => {
    if (event.target.id!=='connector' || active) return;
    const gun=connectors(selectedSite())[Number(event.target.value)];
    if (gun) { connectorKey=keyForGun(gun); message=''; render(); }
  });
  root.addEventListener('click', event => {
    const control=event.target.closest('button');
    if (!control || control.disabled) return;
    if (control.dataset.site!==undefined && !active) {
      chooseSite(locations[Number(control.dataset.site)]); message=''; render(); return;
    }
    switch (control.dataset.act) {
      case 'refresh': message=''; void refreshSites(); break;
      case 'apply-pass': {
        const value=document.getElementById('operator-pass')?.value.trim();
        if (!passPattern.test(value || '')) { message=tr('Enter the 43-character operator pass.','请输入 43 位测试通行证。'); render(); return; }
        message=''; operatorPass=value;
        if (active) { flowPass=value; void sync(); } else void refreshSites();
        break;
      }
      case 'checkout': void checkout(); break;
      case 'check': void sync(); break;
      case 'stop': void stop(); break;
      case 'back': if (active && canLeave(active)) forget(); break;
    }
  });
  langButton.addEventListener('click',() => {
    chinese=!chinese;
    try { localStorage.setItem('afe.live.language',chinese?'zh':'en'); } catch {}
    render();
  });
  function tick() {
    if (active && !document.hidden && document.activeElement?.id!=='operator-pass' && !ended(active) && !active.terminalPayment && !active.blockedBeforeStart) void sync();
  }
  window.addEventListener('pageshow',event=>{if (event.persisted) tick();});
  document.addEventListener('visibilitychange',tick);
  setInterval(tick,6000);
  resume(); render();
  if (active) void sync(); else void refreshSites();
})();
