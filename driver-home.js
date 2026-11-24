/* The directory can show the operator's order-report site while the live feed is offline. */
document.addEventListener('load', event => {
  if (event.target instanceof HTMLImageElement && event.target.classList.contains('driver-tile')) {
    event.target.classList.add('loaded');
  }
}, true);

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
    // The regional view has no marker. Only a coordinate pair from the CPO can pin a station.
    const lat = located ? latitude : -26.075;
    const lon = located ? longitude : 28.058;
    const zoom = located ? 16 : 12;
    mapLink = 'https://www.openstreetmap.org/' + (located ? '?mlat=' + lat + '&mlon=' + lon : '') +
      '#map=' + zoom + '/' + lat + '/' + lon;
    if (Math.abs(lat) <= 85.05) {
      const count = 2 ** zoom;
      const x = (lon + 180) / 360 * count;
      const y = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * count;
      const tiles = [];
      // The map viewport never exceeds 480 CSS pixels. Browser HTTP cache handles repeat views.
      for (let row = Math.max(0,Math.floor(y - 240/256)); row <= Math.min(count-1,Math.floor(y + 240/256)); row++) {
        for (let col = Math.floor(x - 240/256); col <= Math.floor(x + 240/256); col++) {
          const column = (col + count) % count;
          const left = Math.round((col-x) * 256), top = Math.round((row-y) * 256);
          tiles.push('<img alt="" class="driver-tile" width="256" height="256" referrerpolicy="origin" ' +
            'style="left:calc(50% + ' + left + 'px);top:calc(50% + ' + top + 'px)" ' +
            'src="https://tile.openstreetmap.org/' + zoom + '/' + column + '/' + row + '.png">');
        }
      }
      mapContent = '<div class="driver-tile-layer" aria-hidden="true">' + tiles.join('') +
        (located ? '<span class="driver-location-pin"></span>' : '') + '</div>';
    }
  }
  const area = located
    ? selected.city || selected.name || tr('Station location','场站位置')
    : rivonia ? tr('Johannesburg area','约翰内斯堡地区') : selected.name || tr('Station location','场站位置');
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
    fallback + mapContent + (mapContent ? '<a class="driver-map-credit" href="https://www.openstreetmap.org/copyright" ' +
      'rel="noopener noreferrer" target="_blank">© OpenStreetMap</a>' : '') +
    '</div><div class="driver-map-legend"><span>' + esc(area) + ' · ' + mapCaption + '</span>' + mapAlternative +
    '</div></div><section class="station-drawer driver-directory"><div class="driver-grip" aria-hidden="true"></div>' +
    '<div class="drawer-heading"><h2>' + tr('Charging stations','充电场站') + '</h2></div>' + stationList +
    (status ? '<p class="driver-live-note" role="status">' + status + '</p>' : '') + '</section></section>';
}
