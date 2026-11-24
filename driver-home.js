/* The local map is rendered from OSM data. Its bounds use the same projection as the live tiles. */
const rivoniaBounds=[[-26.088,28.022],[-26.022,28.102]];
const rivoniaCenter=[-26.0533333,28.0594444];
let mountedDriverMap=null;
function syncDriverMap(root,tr){
  const host=root.querySelector('[data-driver-map]');
  if(mountedDriverMap && host && mountedDriverMap.key===host.dataset.driverMap){
    host.replaceWith(mountedDriverMap.host);
    mountedDriverMap.map.invalidateSize({pan:false});
    mountedDriverMap.update();
    return;
  }
  if(mountedDriverMap){mountedDriverMap.map.remove();mountedDriverMap=null;}
  if(!host || !window.L)return;
  const map=L.map(host,{zoomControl:false,attributionControl:false,scrollWheelZoom:false,minZoom:2,maxZoom:19});
  const lat=Number(host.dataset.lat),lon=Number(host.dataset.lon),pin=host.dataset.pin==='yes';
  map.setView([lat,lon],pin?16:14);
  const bounds=L.latLngBounds(rivoniaBounds);
  map.createPane('regionalBase').style.zIndex='190';
  L.imageOverlay('./rivonia-map.png',bounds,{pane:'regionalBase',interactive:false,alt:''}).addTo(map);
  const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,referrerPolicy:'origin',keepBuffer:1,updateWhenIdle:true}).addTo(map);
  L.control.zoom({position:'topleft',zoomInTitle:tr('Zoom in','放大'),zoomOutTitle:tr('Zoom out','缩小')}).addTo(map);
  if(pin)L.circleMarker([lat,lon],{radius:8,color:'#fff',weight:3,fillColor:'#16734b',fillOpacity:1,interactive:false}).addTo(map);
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
  mountedDriverMap={host,map,key:host.dataset.driverMap,update};
  tiles.on('tileload load tileerror',update);
  map.on('moveend zoomend',update);
  update();
}

function driverHome({tr, esc, locations, site, loading, catalogError, configured, sourceTime}) {
  const selected = site || locations[0];
  const feedReady = !!sourceTime && !catalogError && configured;
  const reportOnly = !selected && !feedReady;
  const title = tr('Find a charger', '找充电站');
  const refresh = tr('Refresh station status', '刷新场站状态');

  function coordinate(value, limit) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
  }
  const latitude = coordinate(selected?.coordinates?.latitude, 90);
  const longitude = coordinate(selected?.coordinates?.longitude, 180);
  const located = latitude !== null && longitude !== null;
  const rivonia = !selected || [selected.name, selected.address].some(value => /\b382\s+rivonia\b/i.test(value || ''));
  let mapLink = '';
  let mapContent = '';
  if (located || rivonia) {
    const lat = located ? latitude : rivoniaCenter[0];
    const lon = located ? longitude : rivoniaCenter[1];
    const zoom = located ? 16 : 14;
    mapLink = 'https://www.openstreetmap.org/' + (located ? '?mlat=' + lat + '&mlon=' + lon : '') +
      '#map=' + zoom + '/' + lat + '/' + lon;
    if (Math.abs(lat) <= 85.05) {
      mapContent='<div class="driver-live-map" role="region" aria-label="'+tr('Street map','街道地图')+'" data-driver-map="'+
        [lat,lon,zoom,tr('en','zh')].join('/')+'" data-lat="'+lat+'" data-lon="'+lon+'" data-pin="'+(located?'yes':'no')+'"></div>'+
        '<span class="driver-map-status" data-map-status role="status" hidden></span>';
    }
  }
  const area = located
    ? selected.city || selected.name || tr('Station location','场站位置')
    : rivonia ? tr('Rivonia, Sandton','桑顿 · Rivonia') : selected.name || tr('Station location','场站位置');
  const mapCaption = located ? tr('Station location', '场站位置') :
    rivonia ? tr('Area overview', '区域概览') : tr('Coordinates unavailable', '场站坐标待发布');
  const mapAlternative = mapLink ? '<a class="driver-map-link" href="' + esc(mapLink) +
    '" target="_blank" rel="noopener noreferrer">' + tr('Open map ↗', '打开地图 ↗') + '</a>' : '';
  const fallback = '<div class="driver-map-placeholder"><span class="driver-map-fallback-icon" aria-hidden="true">⌖</span>' +
    '<strong>' + esc(reportOnly ? 'Edenburg, Sandton' : area) + '</strong>' +
    '<span>' + (mapLink ? tr('Map preview unavailable','地图预览暂不可用') : mapCaption) + '</span>' + mapAlternative + '</div>';

  function stationButton(item, index) {
    const isReport = index === null;
    const address = isReport ? 'Edenburg, Sandton' : [item.address,item.city].filter(Boolean).join(', ');
    const label = isReport ? tr('From the charging order report','充电订单报表')
      : tr('View connectors','查看枪口');
    return '<button type="button" class="recommended-card driver-site" ' +
      (isReport ? 'data-act="report-site"' : 'data-site="' + index + '"') + '>' +
      '<span class="recommended-avatar" aria-hidden="true">ϟ</span><span class="recommended-copy"><small>' +
      label + '</small><b>' + esc(isReport ? '382 Rivonia' : item.name || item.id) + '</b>' +
      (address ? '<span>' + esc(address) + '</span>' : '') +
      '</span><span class="recommended-arrow" aria-hidden="true">›</span></button>';
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
  return '<section class="home-map-first driver-home" aria-label="' + title + '">' +
    '<header class="map-home-top"><div><h1>' + title + '</h1></div>' +
    (configured ? '<button type="button" class="map-filter-button driver-refresh" data-act="refresh" aria-label="' +
      refresh + '" title="' + refresh + '"' + (loading ? ' disabled' : '') + '><span aria-hidden="true">↻</span></button>' : '') +
    '</header><div class="driver-map-layout"><div class="driver-map-area">' +
    (mapContent || fallback) + (mapContent ? '<a class="driver-map-credit" href="https://www.openstreetmap.org/copyright" ' +
      'rel="noopener noreferrer" target="_blank">© OpenStreetMap contributors</a>' : '') +
    '</div><div class="driver-map-legend"><span>' + esc(area) + ' · ' + mapCaption + '</span>' + mapAlternative +
    '</div></div><section class="station-drawer driver-directory"><div class="driver-grip" aria-hidden="true"></div>' +
    '<div class="drawer-heading"><h2>' + tr('Charging stations','充电场站') + '</h2></div>' + stationList +
    (status ? '<p class="driver-live-note" role="status">' + status + '</p>' : '') + '</section></section>';
}
