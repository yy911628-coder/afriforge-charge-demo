/* Production Hardhitter station catalog for Safari and installed iPhone web apps. */
(() => {
  'use strict';
  const root = document.getElementById('live-charge');
  const langButton = document.getElementById('afe-language');
  const navRoot = document.getElementById('driver-navigation');
  const idFields = ['country_code','party_id','location_id','evse_uid','connector_id'];
  let chinese = navigator.language.toLowerCase().startsWith('zh');
  try { const saved = localStorage.getItem('afe.live.language'); if (saved) chinese = saved === 'zh'; } catch {}
  let locations = [], sourceTime = '', stationKey = '', connectorKey = '';
  let loading = false, catalogError = '', manuallySelected = false;
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
  const payments = productionPayments({tr, esc, pair, render, getAccount:()=>account});
  const account=driverAccount({root,tr,esc,navigate,render,getPage:()=>page,getPayments:()=>payments});
  const priorSession = hasPriorSession();
  let page = 'home';
  let renderedPage = '', lastContent = '', lastNav = '';
  const tabPages = new Set(['home','wallet','scan','orders','profile']);
  function esc(input) {
    return String(input ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function pair(label, value) {
    if (value == null || value === '') return '';
    return '<div class="rec-pair"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }
  const keyFor = (site) => JSON.stringify([site.country_code,site.party_id,site.id]);
  const selectedSite = () => locations.find(s => keyFor(s) === stationKey);
  function connectors(site) {
    if (!site) return [];
    return site.evses.flatMap(e => e.connectors.map(c => ({
      country_code:site.country_code, party_id:site.party_id, location_id:site.id, evse_uid:e.uid,
      connector_id:c.id, standard:c.standard, status:e.status, last_updated:e.last_updated
    })));
  }
  const keyForGun = (gun) => JSON.stringify(idFields.map(k=>gun[k]));
  const selectedGun = () => connectors(selectedSite()).find(g=>keyForGun(g)===connectorKey);
  const eligible = gun => !!gun && gun.standard === 'IEC_62196_T2_COMBO' && gun.status === 'AVAILABLE';
  function chooseSite(site) {
    stationKey = site ? keyFor(site) : '';
    const guns = connectors(site);
    if (!guns.some(g=>keyForGun(g) === connectorKey)) {
      const first = guns.find(eligible) || guns.find(g=>g.standard==='IEC_62196_T2_COMBO') || guns[0];
      connectorKey = first ? keyForGun(first) : '';
    }
  }
  function resumeConnector(target) {
    if (manuallySelected) return selectedGun();
    const site=locations.find(s=>s.id===target.location_id && s.country_code===target.country_code && s.party_id===target.party_id);
    const gun=connectors(site).find(g=>keyForGun(g)===keyForGun(target));
    if (!gun) return null;
    stationKey=keyFor(site); connectorKey=keyForGun(gun); render();
    return gun;
  }

  async function refreshSites() {
    if (loading || !AFE_BASE_URL) return;
    loading = true; catalogError = ''; render();
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
      sourceTime = new Date(data.checkedAt).toISOString();
      const rivonia = locations.find(site => [site.name, site.address].some(
        value => typeof value === 'string' && /\b382\s+rivonia\b/i.test(value)));
      const previous = selectedSite();
      if (page === 'station' && !previous) navigate('home', false);
      chooseSite(previous || rivonia || locations[0]);
      if (!manuallySelected && payments.target()) resumeConnector(payments.target());
    } catch (error) {
      locations = []; sourceTime = ''; chooseSite(null);
      catalogError = error instanceof ChargeApiError ? error.code : 'FEED_UNREACHABLE';
    } finally { loading = false; render(); }
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
  function backButton() {
    return '<button class="app-back" type="button" data-page="home"><span aria-hidden="true">‹</span>' +
      tr('Charging stations','充电场站') + '</button>';
  }
  function reportDetail() {
    return backButton() + '<h1>382 Rivonia</h1><p class="app-muted">Edenburg, Sandton</p>' +
      '<section class="app-card rec-card"><h2>' + tr('Connectors','充电枪') +
      '</h2><p>' + tr('The charging order report lists two connectors. Live status is pending.',
      '场站的充电订单报表记录了两把枪，实时状态待接入。') + '</p><dl class="rec-details">' +
      pair(tr('Local connector 0','本地枪号 0'),'#01-1') + pair(tr('Local connector 1','本地枪号 1'),'#01-2') +
      '</dl></section>';
  }
  function stationDetail() {
    const site = selectedSite();
    if (!site) return backButton() + '<p class="app-card" role="status">' +
      tr('Station details are temporarily unavailable.','暂时无法获取场站详情。') + '</p>';
    const gun = selectedGun(), guns = connectors(site);
    const {latitude,longitude} = site.coordinates || {};
    const validCoordinate = (value,limit) => typeof value === 'string' && value.trim() !== '' &&
      Number.isFinite(Number(value)) && Math.abs(Number(value)) <= limit;
    let directions = '';
    if (validCoordinate(latitude,90) && validCoordinate(longitude,180)) {
      const destination = new URL('https://www.openstreetmap.org/');
      destination.searchParams.set('mlat',latitude);
      destination.searchParams.set('mlon',longitude);
      destination.hash = 'map=16/' + latitude + '/' + longitude;
      directions = '<a class="driver-map-link" target="_blank" rel="noopener noreferrer" href="' +
        esc(destination.href) + '">' + tr('View station on map ↗','查看场站位置 ↗') + '</a>';
    }
    const options = guns.map((g,i) => '<option value="' + i + '"' + (keyForGun(g) === connectorKey ? ' selected' : '') + '>' +
      esc(g.evse_uid + ' / ' + g.connector_id + ' · ' + (g.standard === 'IEC_62196_T2_COMBO' ? 'CCS2' : g.standard || '—') +
      ' · ' + statusLabel(g.status)) + '</option>').join('');
    return backButton() + '<h1>' + esc(site.name || site.id) + '</h1><p class="app-muted">' +
      esc([site.address,site.city].filter(Boolean).join(', ')) + '</p>' + directions +
      '<section class="app-card rec-card"><h2>' + tr('Connectors','充电枪') + '</h2>' +
      (guns.length ? '<div class="rec-picker"><label for="connector">' + tr('Select connector','选择枪口') +
        '</label><select id="connector" class="app-select">' + options + '</select></div>' :
        '<p>' + tr('No connectors published for this station.','该场站尚未发布枪口。') + '</p>') +
      '<dl class="rec-details">' + pair('Location ID',site.id) + pair('EVSE UID',gun?.evse_uid) +
      pair('Connector ID',gun?.connector_id) + pair(tr('CPO status','平台状态'),gun && statusLabel(gun.status)) +
      (gun ? pair(tr('Status updated by CPO','平台状态更新时间'),gun.last_updated || tr('Not reported','未上报')) : '') +
      '</dl><p class="rec-time">' + tr('Catalog checked by AFE · UTC ','AFE 读取目录时间 · UTC ') + esc(sourceTime) + '</p></section>' + payments.card(gun);
  }
  function browse() {
    if (page === 'home') return driverHome({tr,esc,locations,site:selectedSite(),loading,catalogError,configured:!!AFE_BASE_URL,sourceTime});
    if (page === 'report') return reportDetail();
    if (page === 'station') return stationDetail();
    if (account.handles(page)) return account.screen(page);
    const hasOrder = payments.hasOrder();
    const paymentCard = ['wallet','orders'].includes(page) ? payments.card(hasOrder ? selectedGun() : null) : '';
    let screen = driverTab({page,tr,paymentCard,hasOrder});
    if (page === 'orders' && priorSession) screen += '<p class="app-notice" role="status">' +
      tr('For an earlier test payment or charging session, contact the test operator with the original reference.',
        '如需查询之前的测试支付或充电会话，请凭原订单号联系测试负责人。') + '</p>';
    return screen;
  }
  function render() {
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
      syncDriverMap(root,tr);
      root.querySelectorAll('details').forEach((item,i) => { if (openPanels[i]) item.open = true; });
      root.scrollTop = scroll;
      lastContent = content; renderedPage = page;
    }
    const nav = driverNav(tr,account.handles(page) && !['wallet','orders'].includes(page)?'profile':page);
    if (lastNav !== nav) { navRoot.innerHTML = nav; lastNav = nav; }
  }
  function navigate(next, push = true) {
    if (!tabPages.has(next) && !account.handles(next) && !['station','report'].includes(next)) return;
    next=account.target(next);
    if (next !== page && push) history.pushState({afeView:next,stationKey,connectorKey},'');
    const changed=page!==next;page = next;
    if(changed) account.enter(next);
    render();
  }
  function showCode(raw) {
    const match = driverResolveCode(raw,locations);
    if (match.kind === 'report') return navigate('report');
    if (match.kind === 'connector') {
      const site = locations[match.siteIndex];
      const gun = connectors(site).find(g => g.evse_uid === match.evseUid && g.connector_id === match.connectorId);
      if (gun) {
        manuallySelected = true; chooseSite(site); connectorKey = keyForGun(gun);
        return navigate('station');
      }
    }
    const msg = root.querySelector('[data-scan-message]');
    if (msg) msg.textContent = match.kind === 'ambiguous' ?
      tr('This code matches several connectors. Select your station from the map.','此编号对应多个枪口，请从地图选择场站。') :
      tr('This code could not be matched to a published connector. Check the code on the charger.','暂时无法匹配此枪口，请核对桩屏上的编号。');
  }
  function language() {
    chinese = !chinese;
    try { localStorage.setItem('afe.live.language',chinese ? 'zh' : 'en'); } catch {}
    render();
  }
  root.addEventListener('change', event => {
    if (page !== 'station' || event.target.id !== 'connector') return;
    const gun = connectors(selectedSite())[Number(event.target.value)];
    if (gun) { manuallySelected = true; connectorKey = keyForGun(gun); render(); }
  });
  root.addEventListener('submit', event => {
    if (event.target.matches('form[data-account-form]')) { void account.submit(event); return; }
    if (event.target.matches('form[data-driver-code]')) {
      event.preventDefault();
      showCode(event.target.elements.code.value);
    } else payments.submitForm(event,selectedGun());
  });
  root.addEventListener('click', event => {
    const control = event.target.closest('button');
    if (!control || control.disabled) return;
    if(control.dataset.account) return void account.act(control.dataset.account,control.dataset.id);
    if (control.dataset.page) return navigate(control.dataset.page);
    if (control.dataset.site !== undefined) {
      const site = locations[Number(control.dataset.site)];
      if (site) { manuallySelected = true; chooseSite(site); navigate('station'); }
      return;
    }
    switch (control.dataset.act) {
      case 'report-site': return navigate('report');
      case 'scan': return navigate('scan');
      case 'language': return language();
      case 'scan-camera': return void driverScanCamera({root,tr,onCode:showCode});
      case 'stop-camera': return driverStopCamera();
      case 'refresh':
        void refreshSites(); void payments.loadCapability(); void payments.loadCommands(); return;
      default: payments.action(control.dataset.act,selectedGun());
    }
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
  const ready=account.start().then(next=>{if(page==='home' || page==='account-loading')navigate(next,false);});
  void Promise.all([refreshSites(),payments.loadCapability(),payments.loadCommands(),ready])
    .then(async()=>{if(account.active()){await payments.checkStatus();await payments.finishReturn(resumeConnector);}});
})();
