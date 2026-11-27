import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { OcpiSandboxClient } from './ocpi-sandbox-client.mjs';
import { connectorState } from './charger-connection.mjs';

const route = '/api/ocpi/stations';
const reportSiteNumber = 'ZA41020001000001';
const reportSiteName = /\b382\s+rivonia\b/i;
// The station portal supplies the split. OCPI publishes the combined ENERGY price.
const rivoniaRate = Object.freeze({
  id: 'ZA410200010004', currency: 'ZAR', all_day: true, total_per_kwh: '3.0198',
  electricity_per_kwh: '2.8005', service_per_kwh: '0.2193',
  price_source: 'ocpi', breakdown_source: 'station_portal'
});
const rivoniaConnectors = new Map([
  ['ZA41020001000001000100', 'ZA4102000100000100010001'],
  ['ZA41020001000001000101', 'ZA4102000100000100010101']
]);
function directoryOwner(env) {
  const country_code = env.AFE_PRODUCTION_OCPI_CPO_COUNTRY_CODE;
  const party_id = env.AFE_PRODUCTION_OCPI_CPO_PARTY_ID;
  if (country_code === undefined && party_id === undefined) return {country_code:'CN', party_id:'HHD'};
  return {country_code, party_id};
}
const sameOwner = (record, owner) => !!owner?.country_code && !!owner.party_id &&
  record?.country_code === owner.country_code && record?.party_id === owner.party_id;
const isRivonia = (site, owner) => site?.publish === true && site.id === reportSiteNumber && sameOwner(site,owner);
const unavailableRate = Object.freeze({id: rivoniaRate.id, status: 'unavailable'});

class StationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function loadProductionOcpiConfig(env) {
  const rawVersionsUrl = env.AFE_PRODUCTION_OCPI_VERSIONS_URL;
  const rawOrigin = env.AFE_PRODUCTION_OCPI_ORIGIN;
  const token = env.AFE_PRODUCTION_OCPI_TOKEN;
  if (!rawVersionsUrl || !rawOrigin || !token) {
    throw new StationError(503, 'PRODUCTION_OCPI_NOT_CONFIGURED',
      'Production OCPI requires the provider Versions URL, its approved HTTPS origin and the production credential.');
  }
  try {
    const versions = new URL(rawVersionsUrl);
    const origin = new URL(rawOrigin);
    if (origin.href !== origin.origin + '/' || origin.protocol !== 'https:' ||
        versions.origin !== origin.origin || versions.username || versions.password || versions.search || versions.hash ||
        /[\s\x00-\x1f\x7f]/u.test(token)) throw new Error();
    const config = {versionsUrl: versions.href, origin: origin.origin};
    Object.defineProperty(config, 'token', {value: token});
    return config;
  } catch {
    throw new StationError(503, 'PRODUCTION_OCPI_CONFIG_INVALID',
      'Check the production credential and the Versions URL on the configured HTTPS origin.');
  }
}

function scalar(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function coordinate(value, limit) {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && Math.abs(Number(value)) <= limit;
}

function minuteOfDay(time) {
  if (time === '24:00') return 1440;
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

function confirmsAllDayRate(tariff, now) {
  if (tariff?.currency !== rivoniaRate.currency || (tariff.type && tariff.type !== 'REGULAR') ||
      tariff.min_price != null || tariff.max_price != null || !Array.isArray(tariff.elements)) return false;
  if (tariff.start_date_time != null && !(Date.parse(tariff.start_date_time) <= now)) return false;
  if (tariff.end_date_time != null && !(Date.parse(tariff.end_date_time) > now)) return false;
  const periods = [];
  for (const element of tariff.elements) {
    const components = element?.price_components;
    if (!Array.isArray(components) || components.length !== 1) return false;
    const price = components[0];
    if (price?.type !== 'ENERGY' || price.price !== Number(rivoniaRate.total_per_kwh) ||
        price.step_size !== 1 || (price.vat != null && price.vat !== 0)) return false;
    const limits = element.restrictions ?? {};
    if (typeof limits !== 'object' || Array.isArray(limits) ||
        Object.keys(limits).some(key => key !== 'start_time' && key !== 'end_time')) return false;
    const start = minuteOfDay(limits.start_time ?? '00:00');
    const end = minuteOfDay(limits.end_time ?? '24:00');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= 1440 || start === end) return false;
    if (start < end) periods.push([start, end]);
    else periods.push([start, 1440], [0, end]);
  }
  let coveredUntil = 0;
  for (const [start, end] of periods.sort((a, b) => a[0] - b[0])) {
    if (start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, end);
  }
  return coveredUntil === 1440;
}

export async function readRivoniaRate(client, discovery, owner) {
  if (!discovery.endpoints['tariffs:SENDER']) return unavailableRate;
  try {
    const tariffs = await client.listSenderModule(discovery, 'tariffs', {pageSize: 100});
    const matches = tariffs.filter(t => sameOwner(t,owner) && t.id === rivoniaRate.id);
    if (matches.length === 1 && confirmsAllDayRate(matches[0], Date.now())) {
      return {status: 'verified', ...rivoniaRate};
    }
  } catch { /* Locations remain available while the optional price cannot be verified. */ }
  return unavailableRate;
}

// The public feed has no driver context. Only explicitly published sites
// qualify, and nested source records must never pass through to the browser.
export function walletRateFor(site,evse,plug,rate,owner) {
  if (!isRivonia(site,owner) || !plug || rivoniaConnectors.get(evse?.uid)!==plug.id) return null;
  const ids=plug.tariff_ids;
  return ids==null || (Array.isArray(ids) && (!ids.length || ids.includes(rivoniaRate.id))) ? rate : unavailableRate;
}

function publicStations(records, rate, owner) {
  const sites = [];
  for (const site of records) {
    if (site?.publish !== true || !scalar(site.id) || !scalar(site.country_code) || !scalar(site.party_id)) continue;
    const evses = [];
    for (const evse of Array.isArray(site.evses) ? site.evses : []) {
      if (!scalar(evse?.uid)) continue;
      const connectors = (Array.isArray(evse.connectors) ? evse.connectors : [])
        .filter(c => scalar(c?.id))
        .map(c => {
          const target={country_code:site.country_code,party_id:site.party_id,location_id:site.id,evse_uid:evse.uid,connector_id:c.id};
          const connector = {id: c.id, standard: scalar(c.standard), power_type: scalar(c.power_type), ...connectorState(evse,c,target)};
          if (Number.isSafeInteger(c.max_electric_power) && c.max_electric_power > 0) {
            connector.max_electric_power = c.max_electric_power;
            connector.power_source = 'ocpi';
          } else if (isRivonia(site,owner) && rivoniaConnectors.get(evse.uid) === c.id &&
                     c.standard === 'IEC_62196_T2_COMBO' && c.power_type === 'DC') {
            // The station portal rates each of these two physical CCS2 outlets at 120 kW.
            connector.max_electric_power = 120000;
            connector.power_source = 'station_portal';
          }
          const tariff=rate && walletRateFor(site,evse,c,rate,owner);
          if(tariff)connector.tariff=tariff;
          return connector;
        });
      evses.push({uid: evse.uid, status: scalar(evse.status), last_updated: scalar(evse.last_updated), connectors});
    }
    const {latitude, longitude} = site.coordinates ?? {};
    sites.push({
      id: site.id, country_code: site.country_code, party_id: site.party_id, name: scalar(site.name) ?? site.id,
      address: scalar(site.address), city: scalar(site.city), evses,
      coordinates: coordinate(latitude, 90) && coordinate(longitude, 180) ? {latitude, longitude} : undefined
    });
  }
  return sites;
}

export async function readProductionStations(env, fetchImpl = globalThis.fetch) {
  const config = loadProductionOcpiConfig(env);
  const deadline = AbortSignal.timeout(25000);
  const client = new OcpiSandboxClient(config, {
    timeoutMs: 10000,
    fetchImpl: (url, options) => fetchImpl(url, {
      ...options, signal: AbortSignal.any([options.signal, deadline])
    })
  });
  try {
    const discovery = await client.discover({includeTariffs: true});
    const records = await client.listLocations(discovery, {pageSize: 100});
    const owner = directoryOwner(env);
    const matched = records.filter(site => isRivonia(site, owner));
    const rate = matched.length === 1 ? await readRivoniaRate(client, discovery, owner) : null;
    const locations = publicStations(records, rate, owner);
    return {environment: 'production', source: 'cpo', checkedAt: new Date().toISOString(), locations};
  } catch (error) {
    if (/^OCPI HTTP error (401|403)$/.test(error.message)) {
      throw new StationError(502, 'PRODUCTION_OCPI_AUTH_REJECTED', 'The CPO rejected the production credential.');
    }
    throw new StationError(502, 'PRODUCTION_OCPI_READ_FAILED',
      'The production CPO did not return a complete, valid Locations response from its approved origin.');
  }
}

function errorBody(error) {
  return {environment: 'production', error: error.code, message: error.message};
}

export function createProductionStationHandler({env = process.env, fetchImpl = globalThis.fetch} = {}) {
  let fetching;
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    if (req.url !== route) return reply(404, {error: 'NOT_FOUND'});
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return reply(405, {error: 'METHOD_NOT_ALLOWED'});
    }
    try {
      fetching ??= readProductionStations(env, fetchImpl).finally(() => { fetching = undefined; });
      reply(200, await fetching);
    } catch (error) {
      reply(error.status, errorBody(error));
    }
  };
}

export async function preflight(env = process.env, fetchImpl = globalThis.fetch) {
  const feed = await readProductionStations(env, fetchImpl);
  const candidates = feed.locations.filter(site => site.id === reportSiteNumber ||
    reportSiteName.test(site.name) || reportSiteName.test(site.address ?? ''));
  return {checkedAt: feed.checkedAt, environment: feed.environment, publicLocationCount: feed.locations.length,
    target: '382 Rivonia', candidates};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === '--check') {
    try {
      const result = await preflight();
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.candidates.length === 1 && result.candidates[0].evses.some(e => e.connectors.length) ? 0 : 2;
    } catch (error) {
      console.error(JSON.stringify(errorBody(error)));
      process.exitCode = 1;
    }
  } else if (mode === '--serve') {
    const port = Number(process.env.PORT ?? 8080);
    const host = process.env.HOST ?? '127.0.0.1';
    createServer(createProductionStationHandler()).listen(port, host,
      () => console.log('Production OCPI public station service listening on port ' + port));
  } else {
    console.log([
      'Usage: node production-ocpi-stations.mjs --check | --serve',
      '--check reads the production public Locations feed and lists candidates for 382 Rivonia.',
      'Exit 0: one matching site has connectors. Exit 2: no unique site with connectors. Exit 1: read/configuration error.',
      '--serve exposes GET /api/ocpi/stations; HOST defaults to 127.0.0.1 and PORT to 8080.',
      'Configure AFE_PRODUCTION_OCPI_VERSIONS_URL and AFE_PRODUCTION_OCPI_ORIGIN using provider-approved HTTPS values.',
      'On Cloud Run, bind AFE_PRODUCTION_OCPI_TOKEN to the authorized production Secret Manager secret version.'
    ].join('\n'));
    process.exitCode = mode === '--help' ? 0 : 1;
  }
}
