/* The local map is rendered from OSM data. Its bounds use the same projection as the live tiles. */
const rivoniaBounds=[[-26.088,28.022],[-26.022,28.102]];
const rivoniaCenter=[-26.0533333,28.0594444];
const driverStationKey=site=>JSON.stringify([site.country_code,site.party_id,site.id]);

function stationCoordinates(site) {
  const {latitude,longitude}=site?.coordinates || {};
  const valid=(value,limit)=>(typeof value==='number' || (typeof value==='string' && value.trim()!=='')) &&
    Number.isFinite(Number(value)) && Math.abs(Number(value))<=limit;
  return valid(latitude,90) && valid(longitude,180) ? [Number(latitude),Number(longitude)] : null;
}

function stationDirections(site) {
  const point=stationCoordinates(site);
  if (!point) return '';
  const destination=point.join(',');
  const apple=/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  const url=new URL(apple?'https://maps.apple.com/':'https://www.google.com/maps/dir/');
  url.search=apple ? new URLSearchParams({daddr:destination,dirflg:'d'}) :
    new URLSearchParams({api:'1',destination,travelmode:'driving',dir_action:'navigate'});
  return url.href;
}

function driverStationFacts(site,fresh,tr) {
  const guns=site?.evses.flatMap(evse=>evse.connectors.map(c=>({...c,status:c.status || evse.status}))) || [];
  const count=guns.length;
  const known=fresh && site && guns.every(gun=>gun.status && gun.status!=='UNKNOWN');
  const available=guns.filter(gun=>gun.status==='AVAILABLE').length;
  const availability=known ? tr(available+' / '+count+' available',available+' / '+count+' 枪可用') :
    site ? tr(count+' connectors · availability pending','共 '+count+' 枪 · 可用数待确认') : tr('Availability pending','可用枪数待确认');
  const powerKnown=count>0 && guns.every(gun=>Number.isSafeInteger(gun.max_electric_power) && gun.max_electric_power>0);
  const power=powerKnown ? guns.reduce((max,gun)=>Math.max(max,gun.max_electric_power),0)/1000+' kW' : tr('Not published','待公布');
  let price=tr('Rate pending','费率待确认');
  if (fresh && count>0 && guns.every(gun=>gun.tariff?.status==='verified' && gun.tariff.currency && gun.tariff.total_per_kwh!=null)) {
    const rate=guns[0].tariff;
    price=guns.every(gun=>gun.tariff.currency===rate.currency && gun.tariff.total_per_kwh===rate.total_per_kwh) ?
      (rate.currency==='ZAR'?'R':rate.currency+' ')+rate.total_per_kwh+'/kWh' : tr('Varies by connector','按枪口计价');
  }
  return {availability,power,price};
}

function driverStationSheet({tr,findSite,isFresh,viewConnectors}) {
  const sheet=document.getElementById('map-station-sheet');
  const field=name=>sheet.querySelector('[data-map-field="'+name+'"]');
  const closeButton=sheet.querySelector('[data-map-close]'),connectors=sheet.querySelector('[data-map-connectors]');
  const directions=sheet.querySelector('[data-map-directions]');
  let key='',opener=null;
  function update() {
    if (!key) return;
    const site=findSite(key);
    if (!site || !stationCoordinates(site)) {sheet.close();return;}
    const facts=driverStationFacts(site,isFresh(),tr);
    field('name').textContent=site.name || tr('Charging station','充电场站');
    field('address').textContent=site.address || site.city || '';
    field('power-label').textContent=tr('Max per connector','单枪最高功率');
    field('power').textContent=facts.power;
    field('guns-label').textContent=tr('Connectors','充电枪');
    field('guns').textContent=facts.availability;
    field('price-label').textContent=tr('Charging rate','充电费率');
    field('price').textContent=facts.price;
    directions.href=stationDirections(site);
    field('navigate').textContent=tr('Get directions','导航到这里');
    connectors.textContent=tr('View connectors','查看枪口');
    closeButton.setAttribute('aria-label',tr('Close station details','关闭场站信息'));
  }
  closeButton.addEventListener('click',()=>sheet.close());
  sheet.addEventListener('click',event=>{
    if(event.target!==sheet)return;
    const box=sheet.getBoundingClientRect();
    if(event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom)sheet.close();
  });
  sheet.addEventListener('close',()=>{
    if(sheet.open)return;
    key='';
    if(opener?.isConnected)opener.focus({preventScroll:true});
    opener=null;
  });
  connectors.addEventListener('click',()=>{
    const site=findSite(key);
    sheet.close();
    if(site)viewConnectors(site);
  });
  return {update,open(stationKey,element){
    if(!stationCoordinates(findSite(stationKey)))return;
    key=stationKey;opener=element;update();
    if(!sheet.open)sheet.showModal();
  }};
}

let mountedDriverMap=null;
function syncDriverMap(root,tr,sites,onSelect){
  const host=root.querySelector('[data-driver-map]');
  if(mountedDriverMap && host && mountedDriverMap.key===host.dataset.driverMap){
    if(host!==mountedDriverMap.host){
      host.replaceWith(mountedDriverMap.host);
      mountedDriverMap.map.invalidateSize({pan:false});
      mountedDriverMap.update();
    }
    mountedDriverMap.syncPins(sites);
    return;
  }
  if(mountedDriverMap){mountedDriverMap.map.remove();mountedDriverMap=null;}
  if(!host || !window.L)return;
  const map=L.map(host,{zoomControl:false,attributionControl:false,scrollWheelZoom:false,
    touchZoom:'center',doubleClickZoom:'center',minZoom:2,maxZoom:19});
  const lat=Number(host.dataset.lat),lon=Number(host.dataset.lon),pin=host.dataset.pin==='yes';
  map.setView([lat,lon],pin?16:14);
  const bounds=L.latLngBounds(rivoniaBounds);
  map.createPane('regionalBase').style.zIndex='190';
  L.imageOverlay('./rivonia-map.png',bounds,{pane:'regionalBase',interactive:false,alt:''}).addTo(map);
  const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,referrerPolicy:'origin',keepBuffer:1,updateWhenIdle:true}).addTo(map);
  L.control.zoom({position:'topleft',zoomInTitle:tr('Zoom in','放大'),zoomOutTitle:tr('Zoom out','缩小')}).addTo(map);
  const pins=new Map();
  let focusedKey=null;
  const icon=L.divIcon({className:'station-pin',iconSize:[48,56],iconAnchor:[24,53],
    html:'<span class="station-pin-halo"></span><span class="station-pin-drop"><svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M14.4 1.5 3.9 13.9h6.8L9.4 22.5l10.8-13.2h-6.9z"/></svg></span>'});
  function syncPins(locations) {
    const seen=new Set();
    for(const site of locations){
      const point=stationCoordinates(site);
      if(!point || Math.abs(point[0])>85.05)continue;
      const key=driverStationKey(site);
      seen.add(key);
      let marker=pins.get(key);
      if(!marker){
        marker=L.marker(point,{icon,keyboard:true}).addTo(map);
        const element=marker.getElement();
        element.setAttribute('aria-haspopup','dialog');
        element.setAttribute('aria-controls','map-station-sheet');
        const select=()=>{focusedKey=key;onSelect(key,element);};
        marker.on('click',select);
        element.addEventListener('keydown',event=>{
          if(event.key!=='Enter' && event.key!==' ')return;
          event.preventDefault();event.stopPropagation();
          if(!event.repeat)select();
        });
        pins.set(key,marker);
      } else if(!marker.getLatLng().equals(point))marker.setLatLng(point);
      const label=tr('Station details: ','场站信息：')+(site.name || tr('Charging station','充电场站'));
      marker.getElement().setAttribute('aria-label',label);
      marker.getElement().title=label;
    }
    for(const [key,marker] of pins)if(!seen.has(key)){marker.remove();pins.delete(key);}
  }
  syncPins(sites);
  map.on('zoomend',()=>{
    const point=pins.get(focusedKey)?.getLatLng() || (pin && L.latLng(lat,lon));
    if(point && !map.getCenter().equals(point))map.panTo(point,{animate:false});
  });
  const update=()=>{
    const status=host.parentElement?.querySelector('[data-map-status]');
    if(!status)return;
    const view=host.getBoundingClientRect(),local=bounds.contains(map.getCenter());
    const visible=Array.from(host.querySelectorAll('img.leaflet-tile-loaded')).some(img=>{
      const box=img.getBoundingClientRect();
      return box.right>view.left && box.left<view.right && box.bottom>view.top && box.top<view.bottom;
    });
    status.hidden=visible || local;
    status.textContent=tr('Street map unavailable here. Open the map below.','此区域的在线街道地图暂不可用，可点下方打开地图。');
  };
  mountedDriverMap={host,map,key:host.dataset.driverMap,update,syncPins};
  tiles.on('tileload load tileerror',update);
  map.on('moveend zoomend',update);
  update();
}

function driverHome({tr, esc, locations, site, loading, catalogError, configured, sourceTime, returnOrder, plugged=[]}) {
  const selected = site || locations[0];
  const feedReady = !!sourceTime && !catalogError && configured;
  const reportOnly = !selected && !feedReady;
  const title = tr('Find a charger', '找充电站');
  const refresh = tr('Refresh station status', '刷新场站状态');

  const mapSite = stationCoordinates(selected) ? selected : locations.find(item=>stationCoordinates(item)) || selected;
  const point = stationCoordinates(mapSite);
  const located = !!point;
  const rivonia = !mapSite || [mapSite.name, mapSite.address].some(value => /\b382\s+rivonia\b/i.test(value || ''));
  let mapLink = '';
  let mapContent = '';
  if (located || rivonia) {
    const [lat,lon] = point || rivoniaCenter;
    const zoom = located ? 16 : 14;
    mapLink = located ? stationDirections(mapSite) : 'https://www.openstreetmap.org/#map=' + zoom + '/' + lat + '/' + lon;
    if (window.L && Math.abs(lat) <= 85.05) {
      mapContent='<div class="driver-live-map" role="region" aria-label="'+tr('Street map','街道地图')+'" data-driver-map="'+
        [lat,lon,zoom,tr('en','zh')].join('/')+'" data-lat="'+lat+'" data-lon="'+lon+'" data-pin="'+(located?'yes':'no')+'"></div>'+
        '<span class="driver-map-status" data-map-status role="status" hidden></span>';
    }
  }
  const area = located
    ? mapSite.city || mapSite.name || tr('Station location','场站位置')
    : rivonia ? tr('Rivonia, Sandton','桑顿 · Rivonia') : selected.name || tr('Station location','场站位置');
  const mapCaption = located ? tr('Station location', '场站位置') :
    rivonia ? tr('Area overview', '区域概览') : tr('Coordinates unavailable', '场站坐标待发布');
  const mapAlternative = mapLink ? '<a class="driver-map-link" href="' + esc(mapLink) +
    '" target="_blank" rel="noopener noreferrer">' + (located ? tr('Get directions ↗','导航到这里 ↗') : tr('Open map ↗','打开地图 ↗')) + '</a>' : '';
  const fallback = '<div class="driver-map-placeholder"><span class="driver-map-fallback-icon" aria-hidden="true">⌖</span>' +
    '<strong>' + esc(reportOnly ? 'Edenburg, Sandton' : area) + '</strong>' +
    '<span>' + (mapLink ? tr('Map preview unavailable','地图预览暂不可用') : mapCaption) + '</span>' +
    (located ? '<button type="button" data-map-info="'+esc(driverStationKey(mapSite))+'">'+tr('Station details','查看场站信息')+'</button>' : '')+'</div>';

  function stationButton(item, index) {
    const isReport = index === null;
    const address = isReport ? 'Edenburg, Sandton' : [item.address,item.city].filter(Boolean).join(', ');
    const label = isReport ? tr('From the charging order report','充电订单报表')
      : tr('View connectors','查看枪口');
    const {availability,power,price}=driverStationFacts(item,feedReady,tr);
    const directions=stationDirections(item);
    const actions='<div class="home-station-actions">'+(directions?'<a class="driver-map-link" href="'+esc(directions)+'" target="_blank" rel="noopener noreferrer">'+tr('Directions ↗','导航 ↗')+'</a>':'')+
      '<button type="button" data-page="scan">'+tr('Scan to charge','扫码充电')+'</button></div>';
    return '<button type="button" class="recommended-card driver-site" ' +
      (isReport ? 'data-act="report-site"' : 'data-site="' + index + '"') + '>' +
      '<span class="recommended-avatar" aria-hidden="true">ϟ</span><span class="recommended-copy"><small>' +
      label + '</small><b>' + esc(isReport ? '382 Rivonia' : item.name || item.id) + '</b>' +
      (address ? '<span>' + esc(address) + '</span>' : '') +
      '<span class="station-facts"><span>'+tr('Up to ','最高 ')+esc(power)+'</span><span class="station-availability">'+esc(availability)+'</span><span class="driver-site-rate">'+esc(price)+'</span></span>'+
      '</span><span class="recommended-arrow" aria-hidden="true">›</span></button>'+actions;
  }

  let stationList;
  if (selected) {
    const first = locations.indexOf(selected);
    const rest = locations.flatMap((item, i) => i === first ? [] : [stationButton(item, i)]);
    stationList = stationButton(selected, first) + (rest.length ?
      '<details class="driver-more-sites"><summary>' + tr('More stations', '更多场站') + ' (' + rest.length +
      ')</summary>' + rest.join('') + '</details>' : '');
  } else if (reportOnly) {
    stationList = stationButton(null, null);
  } else {
    stationList = '<p class="driver-directory-empty">' + tr('No public stations listed yet.', '暂时没有公开场站。') + '</p>';
  }
  let status = '';
  if (loading) status = tr('Updating live status…', '正在更新实时状态…');
  else if (reportOnly) status = !configured || catalogError === 'PRODUCTION_OCPI_NOT_CONFIGURED'
    ? tr('Live connector status is pending.', '枪口实时状态待接入。')
    : tr('Live connector status is unavailable.', '暂时无法更新枪口状态。');
  const resume=returnOrder?'<button type="button" class="home-charge-action" data-act="return-charge" data-id="'+esc(returnOrder.id)+'">'+tr('Return to this charge','返回本次充电')+(returnOrder.gun?' · '+esc(returnOrder.gun):'')+' <span aria-hidden="true">›</span></button>':'';
  const choose=plugged.length && selected && !resume?'<button type="button" class="home-charge-action" data-site="'+locations.indexOf(selected)+'">'+esc(selected.name)+' · '+
    (plugged.length===1?esc(plugged[0])+tr(' plugged in · choose payment',' 已插枪 · 选支付方式'):tr('Select your plugged-in connector','请选择你已插好的枪口'))+' <span aria-hidden="true">›</span></button>':'';
  return '<section class="home-map-first driver-home" aria-label="' + title + '">' +
    resume+choose+'<header class="map-home-top"><div><h1>' + title + '</h1></div>' +
    (configured ? '<button type="button" class="map-filter-button driver-refresh" data-act="refresh" aria-label="' +
      refresh + '" title="' + refresh + '"' + (loading ? ' disabled' : '') + '><span aria-hidden="true">↻</span></button>' : '') +
    '</header><div class="driver-map-layout"><div class="driver-map-area">' +
    (mapContent || fallback) + (mapContent ? '<a class="driver-map-credit" href="https://www.openstreetmap.org/copyright" ' +
      'rel="noopener noreferrer" target="_blank">© OpenStreetMap contributors</a>' : '') +
    '</div><div class="driver-map-legend"><span>' + esc(area) + ' · ' + mapCaption + '</span>' + (located?'':mapAlternative) +
    '</div></div><section class="station-drawer driver-directory"><div class="driver-grip" aria-hidden="true"></div>' +
    '<div class="drawer-heading"><h2>' + tr('Charging stations','充电场站') + '</h2></div>' + stationList +
    (status ? '<p class="driver-live-note" role="status">' + status + '</p>' : '') + '</section></section>';
}
