/* Production Hardhitter station catalog for Safari and installed iPhone web apps. */
(() => {
  'use strict';
  const root = document.getElementById('live-charge');
  const langButton = document.getElementById('afe-language');
  const navRoot = document.getElementById('driver-navigation');
  const idFields = ['country_code','party_id','location_id','evse_uid','connector_id'];
  const rivoniaSite = {country_code:'ZA', party_id:'AFE', id:'ZA41020001000001'};
  const rivoniaGuns = [
    ['A','ZA41020001000001000100','ZA4102000100000100010001'],
    ['B','ZA41020001000001000101','ZA4102000100000100010101']
  ];
  let chinese = navigator.language.toLowerCase().startsWith('zh');
  try { const saved = localStorage.getItem('afe.live.language'); if (saved) chinese = saved === 'zh'; } catch {}
  let locations = [], sourceTime = '', stationKey = '', connectorKey = '';
  let loading = false, catalogError = '', manuallySelected = false;
  let pendingScan = null;
  let scanIssue = null, checkedGun = '', scannedSiteKey = '';
  let scannedPlug = null, plugTimer, catalogRequest;
  const tr = (en, zh) => chinese ? zh : en;

  // Old payment returns and stored attempts belong to their original environment.
  // Preserve the local record for reconciliation, without opening it or sending its credentials.
  function hasPriorSession() {
    const url = new URL(location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const returnKeys = ['afe_return', 'attempt'];
    const paymentReturn = returnKeys.some(key => fragment.has(key) || url.searchParams.has(key));
    if (paymentReturn) {
      url.hash = '';
      for (const key of returnKeys) url.searchParams.delete(key);
      history.replaceState(null, '', url.pathname + url.search);
      return true;
    }
    try {
      for (let i = 0; i < localStorage.length; i++) {
        if (localStorage.key(i)?.startsWith('afe.sandbox.peach.v1.')) return true;
      }
    } catch {}
    return false;
  }
  const payments = productionPayments({tr, esc, pair, render, getAccount:()=>account,getGun:()=>selectedGun(),onStation:()=>page==='station',sessionLocation});
  const account=driverAccount({root,tr,esc,navigate,render,getPage:()=>page,getPayments:()=>payments,
    getChargeConnector:()=>page==='station' ? connectorKey : ''});
  const priorSession = hasPriorSession();
  let page = 'home';
  let renderedPage = '', lastContent = '', lastNav = '', lastFooter = '';
  const tabPages = new Set(['home','wallet','scan','orders','profile']);
  function esc(input) {
    return String(input ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function pair(label, value) {
    if (value == null || value === '') return '';
    return '<div class="rec-pair"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }
  const keyFor = driverStationKey;
  const selectedSite = () => locations.find(s => keyFor(s) === stationKey);
  const stationSheet = driverStationSheet({
    tr, findSite:key=>page==='home' && locations.find(site=>keyFor(site)===key),
    isFresh:()=>!!sourceTime && !catalogError && !!AFE_BASE_URL,
    viewConnectors:openStation
  });
  function connectors(site) {
    if (!site) return [];
    const rivonia = keyFor(site) === keyFor(rivoniaSite);
    return site.evses.flatMap(e => e.connectors.map(c => ({
      country_code:site.country_code, party_id:site.party_id, location_id:site.id, evse_uid:e.uid,
      connector_id:c.id, standard:c.standard, status:catalogError?'UNKNOWN':String(c.status || e.status || 'UNKNOWN').toUpperCase(), tariff:catalogError?null:c.tariff,
      vehicle_connection:catalogError?'UNKNOWN':(c.vehicle_connection || 'UNKNOWN'),
      reportsPlugOnReserved:rivonia && e.connectors.length===1 && c.standard==='IEC_62196_T2_COMBO' &&
        rivoniaGuns.some(([,uid,id])=>e.uid===uid && c.id===id)
    })));
  }
  const keyForGun = (gun) => JSON.stringify(idFields.map(k=>gun[k]));
  const selectedGun = () => connectors(selectedSite()).find(g=>keyForGun(g)===connectorKey);
  function forgetScan() {
    clearTimeout(plugTimer);
    scannedPlug = null;
  }
  function rememberScan(gun) {
    forgetScan();
    const scan = {key:keyForGun(gun), waited:false, reported:false, checking:false, pending:null, note:''};
    scannedPlug = scan;
    plugTimer = setTimeout(() => {
      if (scannedPlug !== scan || page !== 'station') return;
      scan.waited = true;
      render();
      if (!document.hidden) void refreshSites();
    },5000);
  }
  function canRecheck(gun) {
    return page === 'station' && scannedPlug?.waited && gun && keyForGun(gun) === scannedPlug.key &&
      gun.status === 'AVAILABLE' && gun.vehicle_connection !== 'CONNECTED' && !payments.preview.preview() && !payments.hasOrder() && !payments.pilotRequest(gun);
  }
  function recheckPanel(gun) {
    if(scannedPlug?.pending && gun && keyForGun(gun)===scannedPlug.key)
      return '<div class="plug-recheck" role="status"><p>'+tr('Waiting up to 30 seconds for the station to confirm. Keep this page open.','正在等桩端确认，最多 30 秒。请保持此页打开。')+
        '</p><button type="button" class="rec-refresh" data-act="cancel-plug-check">'+tr('Cancel start request','取消本次启动')+'</button></div>';
    if (!canRecheck(gun)) return '';
    const scan=scannedPlug;
    return '<div class="plug-recheck"><button type="button" class="rec-refresh" data-act="recheck-plug"'+(scan.checking?' disabled':'')+'>'+
      tr('I have plugged in · check again','我已插枪，重新检测')+'</button><p role="status">'+
      (scan.checking ? tr('Checking this connector…','正在查询这把枪…') : scan.note==='expired' ?
        tr('No plug confirmation arrived within 30 seconds. Check the connector and try again.','30 秒内未收到插枪确认。请核对枪口后重试。') : scan.note==='waiting' ?
        tr('The station has not confirmed the connection yet. Check the connector and try again.','桩端尚未确认连接。请核对枪口，然后重试。') :
        tr('Still waiting for the station to report a connection.','正在等待桩端上报连接状态。'))+'</p></div>';
  }
  async function recheckPlug(startRequested) {
    const gun=selectedGun(), scan=scannedPlug;
    if (document.hidden || !canRecheck(gun) || scan.checking || (startRequested && (!scan.reported || !payments.fundingReady(gun)))) return;
    const selection=payments.selectionKey(),deadline=Date.now()+30000;
    const request=startRequested ? {} : null;
    const stillHere=()=>scannedPlug===scan && scan.pending===request && page==='station' && !document.hidden &&
      (!request || (payments.selectionKey()===selection && !payments.preview.preview()));
    scan.pending=request;
    scan.reported=true; scan.checking=true; render();
    const expiry=request && setTimeout(()=>{
      if(scannedPlug===scan && scan.pending===request){
        scan.pending=null;scan.checking=false;scan.note='expired';render();
      }
    },30000);
    try {
      if (catalogRequest) await catalogRequest;
      while(stillHere() && (!request || Date.now()<deadline)){
        await refreshSites();
        const fresh=selectedGun();
        if (!stillHere() || !fresh || keyForGun(fresh)!==scan.key || !['AVAILABLE','PREPARING'].includes(fresh.status)) return;
        if (!request){scan.note='waiting';return;}
        if (fresh.vehicle_connection==='CONNECTED'){
          if(Date.now()<deadline && payments.fundingReady(fresh)) payments.action('station-start',fresh);
          return;
        }
        if(fresh.vehicle_connection==='DISCONNECTED'){scan.note='waiting';return;}
        await new Promise(done=>setTimeout(done,Math.max(0,Math.min(2000,deadline-Date.now()))));
      }
      if(stillHere())scan.note='expired';
    } finally {
      if(expiry)clearTimeout(expiry);
      if(scan.pending===request){scan.pending=null;scan.checking=false;}
      render();
    }
  }
  function cancelPlugStart() {
    if(!scannedPlug?.pending)return;
    scannedPlug.pending=null;scannedPlug.checking=false;scannedPlug.note='';render();
  }
  function chooseSite(site) {
    stationKey = site ? keyFor(site) : '';
    const guns = connectors(site);
    if (!guns.some(g=>keyForGun(g) === connectorKey)) {
      connectorKey = '';
    }
  }
  function openStation(site,fromStationQr=false) {
    manuallySelected=true;
    scannedSiteKey=fromStationQr ? keyFor(site) : '';
    connectorKey='';
    chooseSite(site);
    navigate('station');
  }
  function resumeConnector(target) {
    if (manuallySelected) return selectedGun();
    const site=locations.find(s=>s.id===target.location_id && s.country_code===target.country_code && s.party_id===target.party_id);
    const gun=connectors(site).find(g=>keyForGun(g)===keyForGun(target));
    if (!gun) return null;
    stationKey=keyFor(site); connectorKey=keyForGun(gun); render();
    return gun;
  }

  function refreshSites() {
    if (!AFE_BASE_URL) return Promise.resolve();
    if (!catalogRequest) catalogRequest=updateSites().finally(()=>{catalogRequest=null;});
    return catalogRequest;
  }
  async function updateSites() {
    loading = true; render();
    try {
      const data = await AFEApi.stations();
      if (data?.source !== 'cpo' || !Array.isArray(data.locations) || !Number.isFinite(Date.parse(data.checkedAt))) {
        throw new ChargeApiError(502, 'INVALID_CPO_CATALOG');
      }
      const id = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 36;
      for (const site of data.locations) {
        if (!id(site?.id) || !id(site.country_code) || !id(site.party_id) || !Array.isArray(site.evses) ||
            site.evses.some(evse => !id(evse?.uid) || !Array.isArray(evse.connectors) ||
              evse.connectors.some(connector => !id(connector?.id)))) {
          throw new ChargeApiError(502, 'INVALID_CPO_CATALOG');
        }
      }
      locations = data.locations;
      catalogError = '';
      sourceTime = new Date(data.checkedAt).toISOString();
      const rivonia = locations.find(site => [site.name, site.address].some(
        value => typeof value === 'string' && /\b382\s+rivonia\b/i.test(value)));
      const previous = selectedSite();
      if (page === 'station' && !previous) navigate('home', false);
      chooseSite(previous || rivonia || locations[0]);
      if (!manuallySelected && payments.target()) resumeConnector(payments.target());
      if (scannedPlug && page==='station') {
        const gun=selectedGun();
        if (!gun || keyForGun(gun)!==scannedPlug.key || !['AVAILABLE','PREPARING'].includes(gun.status) ||
            (scannedPlug.pending && gun.vehicle_connection==='DISCONNECTED')) forgetScan();
      }
    } catch (error) {
      sourceTime = '';
      catalogError = error instanceof ChargeApiError ? error.code : 'FEED_UNREACHABLE';
    } finally {
      loading = false;
      render();
      const scan = pendingScan;
      pendingScan = null;
      if (scan && page==='scan') {
        showCode(scan.raw,root.querySelector(scan.fromCamera?'[data-camera-status]':'[data-scan-message]'),scan.fromCamera);
      }
    }
  }
  function statusLabel(raw) {
    if(raw==='PREPARING')return tr('Preparing','准备中');
    switch (raw) {
      case 'UNKNOWN': return tr('Standby / unknown','待机/未知');
      case 'AVAILABLE': return tr('Available','可用');
      case 'CHARGING': return tr('Charging','充电中');
      case 'INOPERATIVE': return tr('Inoperative','不可用');
      case 'OUTOFORDER': return tr('Out of order','故障');
      case 'RESERVED': return tr('Reported reserved','平台报已预约');
      default: return raw || tr('Not reported','未上报');
    }
  }
  function backButton() {
    return '<button class="app-back" type="button" data-page="home"><span aria-hidden="true">‹</span>' +
      tr('Charging stations','充电场站') + '</button>';
  }
  function sessionLocation(t) {
    const site=locations.find(s=>s.id===t.location_id && s.country_code===t.country_code && s.party_id===t.party_id);
    const gun=t.location_id===rivoniaSite.id && rivoniaGuns.find(([,uid,id])=>uid===t.evse_uid && id===t.connector_id);
    return [site?.name || (gun?'382 Rivonia':''),gun && tr('Connector '+gun[0],gun[0]+' 枪')].filter(Boolean).join(' · ');
  }
  function gunPicker(site, guns) {
    // Keep the physical left/right labels even if the CPO reorders or omits a connector.
    const knownSite = site.id === rivoniaSite.id && (keyFor(site) === keyFor(rivoniaSite) ||
      (site.country_code === 'CN' && site.party_id === 'HHD'));
    const slots = knownSite ? rivoniaGuns.map(([letter, uid, id],index) => ({
      label: tr('Connector ' + letter, letter + ' 枪'),
      physicalLabel:'#01-'+(index+1),
      gun: guns.find(g => g.evse_uid === uid && g.connector_id === id)
    })) : [];
    for (const gun of guns) {
      if (!slots.some(slot => slot.gun === gun)) {
        const number = slots.length + 1;
        slots.push({label:tr('Connector ' + number, '枪口 ' + number),gun});
      }
    }
    if (!slots.length) return '<p>' + tr('No connectors published for this station.','该场站尚未发布枪口。') + '</p>';
    const tiles = slots.map(({label,gun,physicalLabel}) => {
      const value = gun && keyForGun(gun);
      const attrs = gun ? ' value="' + esc(value) + '"' + (value === connectorKey ? ' checked' : '') + (payments.preview.session()?' disabled':'') : ' disabled';
      const standard = gun?.standard === 'IEC_62196_T2_COMBO' ? 'CCS2' : gun?.standard;
      const state = gun ? payments.preview.plugReport(gun) || statusLabel(gun.status) : tr('Status unavailable','暂无状态');
      return '<label class="gun-option"><input type="radio" name="charge-connector"' + attrs + '>' +
        '<span class="gun-tile"><strong>' + label + '</strong><span class="gun-mark" aria-hidden="true"></span>' +
        (standard ? '<span class="gun-type">' + esc([standard,physicalLabel].filter(Boolean).join(' · ')) + '</span>' : '') +
        '<span class="gun-status" data-status="' + esc(gun?.status || '') + '">' + esc(state) +
        (payments.preview.usable(gun) && payments.preview.connected(gun)?'<small>'+tr('Connected','已连接')+'</small>':'')+'</span></span></label>';
    }).join('');
    const instruction=scannedSiteKey===keyFor(site) && !connectorKey ?
      '<p class="gun-choice-hint">'+tr('Match the connector label on the charger.','请按桩身标识选择你要使用的枪口。')+'</p>':'';
    return '<fieldset class="gun-picker"><legend>' + tr('Select a connector','选择充电枪') +
      '</legend>'+instruction+'<div class="gun-grid">' + tiles + '</div></fieldset>';
  }
  function reportDetail() {
    return backButton() + '<h1>382 Rivonia</h1><p class="app-muted">Edenburg, Sandton</p>' +
      '<section class="app-card rec-card">' + gunPicker(rivoniaSite, []) +
      '<p>' + tr('Live connector status is unavailable.','暂时无法读取枪口实时状态。') + '</p></section>';
  }
  function tariffDetails(rate) {
    if (rate?.status !== 'verified') return '<p class="rec-time">' + tr('The current charging rate is unavailable.','当前充电单价暂无法核实。') + '</p>';
    const currency = rate.currency === 'ZAR' ? 'R' : esc(rate.currency) + ' ';
    return '<section class="rec-tariff"><div class="rec-tariff-heading"><h3>' + tr('Charging fee','充电费用') + '</h3>' +
      (rate.all_day ? '<span>' + tr('All day','全天') + '</span>' : '') + '</div>' +
      '<p class="rec-tariff-total"><strong>' + currency + esc(rate.total_per_kwh) + '</strong><span>/kWh</span></p></section>';
  }
  function stationDetail() {
    const session=payments.sessionScreen();
    if(session)return backButton()+session;
    const site = selectedSite();
    if (!site) return backButton() + '<p class="app-card" role="status">' +
      tr('Station details are temporarily unavailable.','暂时无法获取场站详情。') + '</p>';
    const gun = selectedGun(), guns = connectors(site);
    const destination=stationDirections(site);
    const directions=destination ? '<a class="driver-map-link" target="_blank" rel="noopener noreferrer" href="' +
      esc(destination) + '">' + tr('Get directions ↗','导航到这里 ↗') + '</a>' : '';
    return backButton() + '<h1>' + esc(site.name || tr('Charging station','充电场站')) + '</h1><p class="app-muted">' +
      esc([site.address,site.city].filter(Boolean).join(', ')) + '</p>' + directions +
      '<section class="app-card rec-card station-connectors">' + gunPicker(site,guns) +
      payments.preview.banner(gun,{loading,refreshed:!!gun && !catalogError && checkedGun===keyForGun(gun),recheck:!!canRecheck(gun),pilot:payments.pilotRequest(gun)})+
      recheckPanel(gun)+(gun ? tariffDetails(gun.tariff) : '') + '</section>' + payments.card(gun,true);
  }
  function scanRecovery() {
    if(!scanIssue)return {};
    const {kind,label}=scanIssue;
    const choices=!catalogError && sourceTime ? locations.filter(site=>site.evses.some(e=>e.connectors.length)).map(site=>
      '<button type="button" class="rec-refresh" data-scan-site="'+esc(keyFor(site))+'">'+
      esc(tr('Choose connector at '+(site.name || site.id),'手选 '+(site.name || site.id)+' 的枪口'))+'</button>').join('') : '';
    const message=catalogError || !sourceTime ?
      tr('Code received. The station list is unavailable. Refresh to try again.','已读到编号，场站目录暂不可用。请刷新后重试。') :
      !choices ? tr('The station list has no published connectors. Refresh to try again.','当前目录没有可选枪口，请刷新后重试。') :
      kind==='ambiguous' ? tr('This code has multiple matches. Choose the connector shown on the charger.','此编号有多个匹配，请按充电桩上的枪号手选。') :
      tr('Code read'+label+'. Connector unconfirmed. Scan the QR beside the connector label, or choose your station and connector below.',
        '已读到编号'+label+'，枪口待核实。请扫标有枪号的二维码，或按桩身标识手动选枪。');
    return {scanFeedback:esc(message),scanChoices:'<div class="scan-recovery">'+(choices ||
      '<button type="button" class="rec-refresh" data-act="refresh-scan"'+(loading?' disabled':'')+'>'+
      tr(loading?'Updating…':'Refresh station list',loading?'正在刷新…':'刷新场站目录')+'</button>')+'</div>'};
  }
  function browse() {
    if (page === 'home') return driverHome({tr,esc,locations,site:selectedSite(),loading,catalogError,configured:!!AFE_BASE_URL,sourceTime});
    if (page === 'report') return reportDetail();
    if (page === 'station') return stationDetail();
    if (account.handles(page)) return account.screen(page);
    const hasOrder = payments.hasOrder();
    const paymentCard = ['wallet','orders'].includes(page) ? payments.card(hasOrder ? selectedGun() : null) : '';
    let screen = driverTab({page,tr,paymentCard,hasOrder,...(page==='scan' && scanRecovery())});
    if (page === 'orders' && priorSession) screen += '<p class="app-notice" role="status">' +
      tr('For an earlier test payment or charging session, contact the test operator with the original reference.',
        '如需查询之前的测试支付或充电会话，请凭原订单号联系测试负责人。') + '</p>';
    return screen;
  }
  function render() {
    payments.preview.syncOwner();
    document.documentElement.lang = chinese ? 'zh-CN' : 'en';
    langButton.textContent = chinese ? 'English' : '中文';
    langButton.setAttribute('aria-label',chinese ? 'Switch to English' : '切换为中文');
    root.setAttribute('aria-busy',String(page === 'home' && loading));
    const content = browse(), samePage = page === renderedPage;
    if (!samePage || content !== lastContent) {
      const scroll = samePage ? root.scrollTop : 0;
      const openPanels = samePage ? Array.from(root.querySelectorAll('details'), item => item.open) : [];
      if (renderedPage === 'scan') driverStopCamera();
      root.innerHTML = content;
      root.querySelectorAll('details').forEach((item,i) => { if (openPanels[i]) item.open = true; });
      root.scrollTop = scroll;
      lastContent = content; renderedPage = page;
    }
    syncDriverMap(root,tr,locations,stationSheet.open);
    stationSheet.update();
    const nav = driverNav(tr,account.handles(page) && !['wallet','orders'].includes(page)?'profile':page);
    if (lastNav !== nav) { navRoot.innerHTML = nav; lastNav = nav; }
    const gun=selectedGun();
    const dock=document.getElementById('station-action');
    const footer=page!=='station'?'':payments.hasDispatch()?payments.sessionFooter():scannedPlug?.pending?
      '<button type="button" disabled class="station-primary">'+tr('Waiting for the charger…','等待充电桩确认…')+'</button>':
      payments.footer(gun,canRecheck(gun) && scannedPlug.reported && !scannedPlug.checking);
    if(lastFooter!==footer){dock.innerHTML=footer;lastFooter=footer;}
    dock.hidden=!footer;
    const overlay=document.getElementById('charge-progress');
    overlay.hidden=!(page==='station' && payments.isStarting());
    if(!overlay.hidden)overlay.querySelector('strong').textContent=payments.preview.preview()?tr('Starting demo charging…','正在模拟启动充电…'):tr('Starting your charging session…','正在启动充电…');
    root.closest('.app-root').inert=!overlay.hidden;
  }
  function navigate(next, push = true) {
    if (!tabPages.has(next) && !account.handles(next) && !['station','report'].includes(next)) return;
    next=account.target(next);
    if (next !== page && push) history.pushState({afeView:next,stationKey,connectorKey},'');
    const changed=page!==next;
    if(changed && page==='scan'){scanIssue=null;pendingScan=null;}
    if(changed)checkedGun='';
    if(changed && page==='station'){scannedSiteKey='';forgetScan();payments.resetCredit();payments.preview.leave();}
    page = next;
    if(changed) account.enter(next);
    render();
    if(changed && next==='station' && (!sourceTime || Date.now()-Date.parse(sourceTime)>8000))void refreshSites();
  }
  function showCode(raw, feedback = root.querySelector('[data-scan-message]'), fromCamera=false) {
    if (!feedback) return;
    pendingScan = null;
    if (loading && !sourceTime) {
      pendingScan = {raw,fromCamera};
      feedback.textContent = tr('Code received. Looking up the connector…','已读到编号，正在查询枪口…');
      return;
    }
    const match = driverResolveCode(raw,locations);
    if (match.kind === 'report' && !AFE_BASE_URL) return navigate('report');
    if (match.kind === 'station' && sourceTime && !catalogError) return openStation(locations[match.siteIndex],fromCamera);
    if (match.kind === 'connector' && sourceTime && !catalogError) {
      const site = locations[match.siteIndex];
      const gun = connectors(site).find(g => g.evse_uid === match.evseUid && g.connector_id === match.connectorId);
      if (gun) {
        manuallySelected = true; chooseSite(site); connectorKey = keyForGun(gun);
        if (fromCamera) rememberScan(gun); else forgetScan();
        return navigate('station');
      }
    }
    const id = raw.trim();
    const label = /^[A-Za-z0-9_-]{1,36}$/.test(id) ? ` (${id})` : '';
    scanIssue={kind:match.kind,label};
    if(catalogError || !sourceTime)scanIssue.retry={raw:id.slice(0,1024),fromCamera};
    render();
    if(!fromCamera)root.querySelector('#driver-code').value=id.slice(0,1024);
  }
  function language() {
    chinese = !chinese;
    try { localStorage.setItem('afe.live.language',chinese ? 'zh' : 'en'); } catch {}
    render();
  }
  root.addEventListener('change', event => {
    if(page==='station' && event.target.matches('[data-station-vehicle],[data-station-credit],[data-charge-card],input[name="charge-connector"]'))cancelPlugStart();
    if(event.target.matches('[data-station-credit]')){payments.selectCredit(event.target.checked,selectedGun());return;}
    if(event.target.matches('[data-station-vehicle]')){payments.chooseVehicle(event.target.value);return;}
    if (event.target.matches('select[data-charge-card]')) { payments.chooseCard(event.target.value); return; }
    if (page !== 'station' || !event.target.matches('input[name="charge-connector"]:checked')) return;
    const gun = connectors(selectedSite()).find(g => keyForGun(g) === event.target.value);
    if (gun) {
      forgetScan();
      checkedGun='';
      manuallySelected = true; connectorKey = keyForGun(gun);
      if(scannedSiteKey===stationKey && ['AVAILABLE','PREPARING'].includes(gun.status))rememberScan(gun);
      history.replaceState({afeView:page,stationKey,connectorKey},'');
      render();
      root.querySelector('input[name="charge-connector"]:checked')?.focus({preventScroll:true});
    }
  });
  root.addEventListener('submit', event => {
    if (event.target.matches('form[data-account-form]')) { void account.submit(event); return; }
    if (event.target.matches('form[data-driver-code]')) {
      event.preventDefault();
      driverStopCamera();
      showCode(event.target.elements.code.value);
    } else payments.submitForm(event,selectedGun());
  });
  root.addEventListener('click', event => {
    const control = event.target.closest('button');
    if (!control || control.disabled) return;
    if(control.dataset.account) return void account.act(control.dataset.account,control.dataset.id);
    if (control.dataset.page) return navigate(control.dataset.page);
    if (control.dataset.scanSite && page==='scan') {
      const site=locations.find(s=>keyFor(s)===control.dataset.scanSite);
      if(site && !catalogError)openStation(site);
      return;
    }
    if (control.dataset.mapInfo) return stationSheet.open(control.dataset.mapInfo,control);
    if (control.dataset.site !== undefined) {
      const site = locations[Number(control.dataset.site)];
      if (site) openStation(site);
      return;
    }
    switch (control.dataset.act) {
      case 'report-site': return navigate('report');
      case 'scan': return navigate('scan');
      case 'language': return language();
      case 'scan-camera':
        pendingScan = null;
        if(scanIssue){scanIssue=null;render();}
        root.querySelector('[data-scan-message]').textContent = '';
        return void driverScanCamera({root,tr,onCode:(raw,feedback)=>showCode(raw,feedback,true)});
      case 'recheck-plug': return void recheckPlug(false);
      case 'refresh-gun': {
        const gun=selectedGun();
        if(page==='station' && gun){checkedGun=keyForGun(gun);void refreshSites();}
        return;
      }
      case 'refresh-scan':
        if(scanIssue?.retry)pendingScan=scanIssue.retry;
        return void refreshSites();
      case 'cancel-plug-check': return cancelPlugStart();
      case 'stop-camera': return driverStopCamera();
      case 'refresh':
        void refreshSites(); void payments.loadCapability(); void payments.loadCommands(); return;
      default: cancelPlugStart();payments.action(control.dataset.act,selectedGun());
    }
  });
  document.getElementById('station-action').addEventListener('click',e=>{
    const b=e.target.closest('button[data-act]');
    if(!b || b.disabled || page!=='station')return;
    if(b.dataset.act==='verify-then-start')void recheckPlug(true);
    else payments.action(b.dataset.act,selectedGun());
  });
  navRoot.addEventListener('click', event => {
    const tab = event.target.closest('button[data-page]');
    if (tab) navigate(tab.dataset.page);
  });
  window.addEventListener('popstate', event => {
    let next = event.state?.afeView || 'home';
    if (next === 'station') {
      const site = locations.find(s => keyFor(s) === event.state.stationKey);
      if (site) { connectorKey = event.state.connectorKey; chooseSite(site); manuallySelected = true; }
      else next = 'home';
    }
    navigate(next,false);
  });
  langButton.addEventListener('click',language);
  history.replaceState({afeView:page},'');
  render();
  const sitesReady=refreshSites();
  const ready=account.start().then(async next=>{
    const returned=account.takeCardReturn();
    if (returned) {
      await sitesReady;
      const site=locations.find(s=>connectors(s).some(g=>keyForGun(g)===returned.connector));
      if (site && (page==='home' || page==='account-loading')) {
        chooseSite(site); connectorKey=returned.connector; manuallySelected=true; next='station';payments.linked(returned.cardId,returned.vehicleId);
        history.replaceState({afeView:next,stationKey,connectorKey},'');
      }
    }
    if(page==='home' || page==='account-loading') navigate(next,false);
    else if (page==='station' && account.active()) { render(); void account.loadWallet(); }
  });
  void Promise.all([sitesReady,payments.loadCapability(),payments.loadCommands(),ready])
    .then(async()=>{if(account.active()){await payments.checkStatus();await payments.finishReturn(resumeConnector);}});
  function pollCatalog(){
    if(document.hidden)return;
    if(page==='station' || (page==='home' && (!sourceTime || Date.now()-Date.parse(sourceTime)>=30000)))void refreshSites();
  }
  setInterval(pollCatalog,8000);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelPlugStart();else pollCatalog();});
})();
