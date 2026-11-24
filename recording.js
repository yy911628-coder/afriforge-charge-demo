/* Production Hardhitter station catalog for Safari and installed iPhone web apps. */
(() => {
  'use strict';
  const root = document.getElementById('live-charge');
  const langButton = document.getElementById('afe-language');
  const idFields = ['country_code','party_id','location_id','evse_uid','connector_id'];
  let chinese = navigator.language.toLowerCase().startsWith('zh');
  try { const saved = localStorage.getItem('afe.live.language'); if (saved) chinese = saved === 'zh'; } catch {}
  let locations = [], sourceTime = '', stationKey = '', connectorKey = '';
  let loading = false, catalogError = '';
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
  const priorSession = hasPriorSession();
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
      connector_id:c.id, standard:c.standard, status:e.status
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
      chooseSite(selectedSite() || rivonia || locations[0]);
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
  function browse() {
    const site=selectedSite(), gun=selectedGun(), guns=connectors(site);
    const refresh = AFE_BASE_URL ? '<button class="rec-refresh" data-act="refresh" type="button"'+(loading?' disabled':'')+'>'+
      tr('Refresh','刷新')+'</button>' : '';
    const title='<div class="rec-heading"><div><p class="app-small">HARDHITTER · OCPI</p><h1>'+
      tr('Charging stations','充电场站')+'</h1></div>'+refresh+'</div>';
    let catalog = '';
    if (!AFE_BASE_URL) {
      catalog='<p class="app-card" role="status">'+tr('The production station service has not been configured.','生产场站接口尚未配置。')+'</p>';
    } else if (catalogError) {
      catalog='<p class="app-notice rec-error" role="status">'+tr('Production station feed unavailable','暂时无法读取生产场站目录')+' · '+esc(catalogError)+'</p>';
    } else if (!site) {
      catalog='<p class="app-card" role="status">'+(loading?tr('Loading stations…','正在读取场站…'):tr('No public stations in the production catalog.','生产目录中暂无公开场站。'))+'</p>';
    } else {
      const list=locations.map((s,i)=>'<button class="rec-station" type="button" data-site="'+i+'" aria-pressed="'+(s===site)+'"><strong>'+
        esc(s.name || s.id)+'</strong><span>'+esc([s.address,s.city].filter(Boolean).join(', ') || s.id)+'</span></button>').join('');
      const options=guns.map((g,i)=>'<option value="'+i+'"'+(keyForGun(g)===connectorKey?' selected':'')+'>'+
        esc(g.evse_uid+' / '+g.connector_id+' · '+(g.standard==='IEC_62196_T2_COMBO'?'CCS2':g.standard || '—')+' · '+statusLabel(g.status))+'</option>').join('');
      catalog='<section class="app-card rec-card"><div class="app-row"><h2>'+tr('Stations','场站列表')+'</h2><span class="rec-time">'+locations.length+'</span></div>'+
        '<div class="rec-sites">'+list+'</div>'+map(site)+'<p class="rec-time">'+tr('CPO catalog · UTC ','海汇德目录 · UTC ')+esc(sourceTime)+'</p></section>'+
        '<section class="app-card rec-card"><h2>'+esc(site.name || site.id)+'</h2>'+
        (guns.length?'<div class="rec-picker"><label for="connector">'+tr('Select connector','选择枪口')+'</label><select id="connector" class="app-select">'+options+'</select></div>':'')+
        '<dl class="rec-details">'+pair('Location ID',site.id)+pair('EVSE UID',gun?.evse_uid)+pair('Connector ID',gun?.connector_id)+
        pair(tr('CPO status','平台状态'),gun && statusLabel(gun.status))+'</dl></section>';
    }
    const access='<section class="app-card rec-card"><h2>'+tr('Charging','充电')+'</h2><p>'+
      tr('Payments and remote start/stop are unavailable in this production app.',
         '正式版暂未开通支付和远程启停。')+'</p></section>';
    const legacy=priorSession ? '<p class="app-notice" role="status">'+
      tr('For an earlier test payment or charging session, contact the test operator with the original reference.',
         '如需查询之前的测试支付或充电会话，请凭原订单号联系测试负责人。')+'</p>' : '';
    return title + catalog + access + legacy;
  }
  function render() {
    const scroll=root.scrollTop;
    document.documentElement.lang=chinese?'zh-CN':'en';
    langButton.textContent=chinese?'English':'中文';
    root.setAttribute('aria-busy',String(loading));
    root.innerHTML=browse();
    root.scrollTop=scroll;
  }
  root.addEventListener('change', event => {
    if (event.target.id!=='connector') return;
    const gun=connectors(selectedSite())[Number(event.target.value)];
    if (gun) { connectorKey=keyForGun(gun); render(); }
  });
  root.addEventListener('click', event => {
    const control=event.target.closest('button');
    if (!control || control.disabled) return;
    if (control.dataset.site!==undefined) {
      chooseSite(locations[Number(control.dataset.site)]); render();
    } else if (control.dataset.act==='refresh') void refreshSites();
  });
  langButton.addEventListener('click',() => {
    chinese=!chinese;
    try { localStorage.setItem('afe.live.language',chinese?'zh':'en'); } catch {}
    render();
  });
  render();
  void refreshSites();
})();
