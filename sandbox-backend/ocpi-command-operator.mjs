// Operator CLI only. Operate on one stable test attempt using the operator's ADC.
import { pathToFileURL } from 'node:url';
import { validateOcpiCommand } from './ocpi-sandbox-commands.mjs';
import { connectorState, isRivoniaConnector } from './charger-connection.mjs';

const START = 'START_SESSION';
const STOP = 'STOP_SESSION';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const country = /^[A-Z]{2}$/;
const party = /^[A-Z0-9]{3}$/;
const validId = value => typeof value === 'string' && /^[\x20-\x7e]{1,36}$/.test(value) && value.trim().length > 0;
const validCountry = value => typeof value === 'string' && country.test(value);
const validParty = value => typeof value === 'string' && party.test(value);
const fieldEquals = (a, b) => validId(a) && validId(b) && a.toUpperCase() === b.toUpperCase();
const sessionStatuses = new Set(['ACTIVE', 'COMPLETED', 'INVALID', 'PENDING', 'RESERVATION']);
const commandStates = new Set(['NOT_SUPPORTED', 'REJECTED', 'ACCEPTED', 'UNKNOWN_SESSION', 'CANCELED_RESERVATION',
  'EVSE_OCCUPIED', 'EVSE_INOPERATIVE', 'FAILED', 'TIMEOUT', 'UNKNOWN_RESERVATION']);

class OperatorError extends Error {}
function fail(code) { throw new OperatorError(code); }

function callbackOrigin(value) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) fail('INVALID_CALLBACK_ORIGIN');
  let parsed;
  try { parsed = new URL(value); } catch { fail('INVALID_CALLBACK_ORIGIN'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/') fail('INVALID_CALLBACK_ORIGIN');
  return parsed.origin;
}

function driverToken(env, transportToken) {
  let token;
  try { token = JSON.parse(env.AFE_OCPI_APP_USER_TOKEN_JSON); } catch { fail('INVALID_APP_USER_TOKEN'); }
  if (!token || token.type !== 'APP_USER' || token.valid !== true) fail('INVALID_APP_USER_TOKEN');
  const credentials = [transportToken, Buffer.from(transportToken, 'utf8').toString('base64')];
  const values = [...Object.values(token), ...Object.values(token.energy_contract ?? {})];
  if (values.some(value => credentials.includes(value))) fail('TRANSPORT_TOKEN_USED_AS_DRIVER_TOKEN');
  return token;
}

function startDetails(env, config, token, attemptId) {
  const details = {
    country_code: env.AFE_OCPI_CPO_COUNTRY_CODE, party_id: env.AFE_OCPI_CPO_PARTY_ID,
    location_id: env.AFE_OCPI_LOCATION_ID, evse_uid: env.AFE_OCPI_EVSE_UID, connector_id: env.AFE_OCPI_CONNECTOR_ID,
    authorization_reference: attemptId, callback_origin: callbackOrigin(env.AFE_OCPI_COMMAND_CALLBACK_ORIGIN),
    versions_url: config.versionsUrl, from_country_code: token.country_code, from_party_id: token.party_id
  };
  if (!validCountry(details.country_code) || !validParty(details.party_id) ||
      ![details.location_id, details.evse_uid, details.connector_id].every(validId)) fail('INVALID_CONFIRMED_TARGET');
  return details;
}

export function requireAvailableGun(locations, target, {publishedOnly = false, available = true, pilot = false} = {}) {
  const equal = publishedOnly ? (a,b) => validId(a) && a === b : fieldEquals;
  const matches = locations.filter(loc => loc && (!publishedOnly || loc.publish === true) && equal(loc.country_code, target.country_code) &&
    equal(loc.party_id, target.party_id) && equal(loc.id, target.location_id));
  if (matches.length !== 1) fail('TARGET_LOCATION_MISSING_OR_AMBIGUOUS');
  const evses = (matches[0].evses || []).filter(evse => equal(evse?.uid, target.evse_uid));
  if (evses.length !== 1) fail('TARGET_EVSE_MISSING_OR_AMBIGUOUS');
  if (publishedOnly && Array.isArray(evses[0].capabilities) && !evses[0].capabilities.includes('REMOTE_START_STOP_CAPABLE')) {
    fail('TARGET_REMOTE_COMMANDS_UNAVAILABLE');
  }
  const plugs = (evses[0].connectors || []).filter(plug => equal(plug?.id, target.connector_id));
  if (plugs.length !== 1 || plugs[0].standard !== 'IEC_62196_T2_COMBO') fail('TARGET_CCS2_CONNECTOR_NOT_CONFIRMED');
  if (available) {
    const state = connectorState(evses[0],plugs[0],target);
    const rivonia=publishedOnly && isRivoniaConnector(target) && evses[0].connectors.length===1;
    if (publishedOnly && (rivonia || pilot) && evses[0].connectors.length === 1 && ['AVAILABLE','RESERVED'].includes(state.status)) {
      const portStatus=plugs[0].status?.trim().toUpperCase();
      if (portStatus && !['AVAILABLE','PREPARING','RESERVED'].includes(portStatus)) fail('TARGET_EVSE_NOT_AVAILABLE');
      // Hardhitter reports a plugged-in cable as RESERVED at these two EVSEs.
      if (rivonia) return state.status;
      if (state.vehicle_connection==='DISCONNECTED') fail('TARGET_VEHICLE_NOT_CONNECTED');
      if (state.status==='RESERVED') fail('TARGET_RESERVATION_UNVERIFIED');
      return;
    }
    if (!['AVAILABLE','PREPARING'].includes(state.status)) fail('TARGET_EVSE_NOT_AVAILABLE');
    if (publishedOnly && state.vehicle_connection !== 'CONNECTED') fail('TARGET_VEHICLE_NOT_CONNECTED');
  }
}

export async function verifyStartGun(client, discovery, locations, target, publishedOnly, driverToken, pilot=!!driverToken) {
  let pluggedAtRivonia=false;
  try {
    pluggedAtRivonia=requireAvailableGun(locations,target,{publishedOnly,pilot})==='RESERVED';
    if (!pluggedAtRivonia) return;
  }
  catch (error) {
    if (error.message!=='TARGET_RESERVATION_UNVERIFIED') throw error;
  }
  let sessions;
  try { sessions=await client.listSenderModule(discovery,'sessions'); }
  catch {
    // This site's plug signal does not require a reservation. The CPO authorizes the command itself.
    if (pluggedAtRivonia) return;
    fail('TARGET_RESERVATION_LOOKUP_UNAVAILABLE');
  }
  const live=sessions.filter(s=>s && ['ACTIVE','PENDING','RESERVATION'].includes(s.status) &&
    !(pluggedAtRivonia && s.end_date_time) &&
    ['country_code','party_id','location_id','evse_uid'].every(k=>fieldEquals(s[k],target[k])));
  if (pluggedAtRivonia && live.length===0) return;
  if (live.some(s=>s.status==='ACTIVE')) fail('TARGET_EVSE_NOT_AVAILABLE');
  const [reservation]=live;
  if (!driverToken || live.length!==1 || reservation.status!=='RESERVATION' || !validId(reservation.id) ||
      reservation.end_date_time || !fieldEquals(reservation.connector_id,target.connector_id) ||
      !['country_code','party_id','uid','type','contract_id'].every(k=>reservation.cdr_token?.[k]===driverToken[k])) fail('TARGET_RESERVATION_UNVERIFIED');
}

function matchingSession(sessions, details) {
  const matches = sessions.filter(session => session && [
    'authorization_reference', 'country_code', 'party_id', 'location_id', 'evse_uid', 'connector_id'
  ].every(field => fieldEquals(session[field], details[field])));
  if (!matches.length) return {state: 'NOT_FOUND'};
  if (matches.length !== 1) return {state: 'AMBIGUOUS'};
  const [{id, status, kwh}] = matches;
  if (!validId(id) || !sessionStatuses.has(status)) return {state: 'INVALID_RECORD'};
  const result = {state: 'MATCHED', id, status};
  if (typeof kwh === 'number' && Number.isFinite(kwh) && kwh >= 0) result.kwh = kwh;
  const matched=matches[0];
  if (typeof matched.start_date_time==='string' && Number.isFinite(Date.parse(matched.start_date_time))) result.startedAt=matched.start_date_time;
  let latest=-Infinity;
  for (const period of Array.isArray(matched.charging_periods)?matched.charging_periods:[]) {
    const time=Date.parse(period?.start_date_time);
    if (!Number.isFinite(time) || time<latest || !Array.isArray(period.dimensions)) continue;
    const soc=period.dimensions.find(d=>d?.type==='STATE_OF_CHARGE' && Number.isFinite(d.volume) && d.volume>=0 && d.volume<=100);
    if (soc) {result.soc=soc.volume; latest=time;}
  }
  if (typeof matches[0].last_updated==='string' && Number.isFinite(Date.parse(matches[0].last_updated))) result.updatedAt=matches[0].last_updated;
  return result;
}

async function lookupSession(client, discovery, start) {
  const reservedAt = Date.parse(start.createdAt);
  if (!Number.isFinite(reservedAt)) fail('INVALID_START_RECORD_TIME');
  // Include the start even if the CPO clock runs a few minutes behind the operator.
  const dateFrom = new Date(reservedAt - 5 * 60 * 1000).toISOString();
  const sessions = await client.listSenderModule(discovery, 'sessions', {dateFrom});
  return matchingSession(sessions, start.details);
}

function commandSummary(record) {
  if (!record) return null;
  const report = value => commandStates.has(value) ? value : null;
  return {ack: report(record.response?.result), callback: report(record.result?.result),
    ...(record.respondedAt && {acknowledgedAt:record.respondedAt}),
    ...(record.completedAt && {callbackAt:record.completedAt})};
}

export async function runOcpiOperator(operation, attemptId, {client, journal, sendCommand, env, publishedOnly = false, pilot = false}) {
  if (!['start', 'status', 'stop'].includes(operation) || typeof attemptId !== 'string' || !uuid.test(attemptId)) {
    fail('USAGE: start|status|stop <canonical-lowercase-uuid>');
  }
  const start = await journal.get(attemptId, START);
  if (operation === 'start' && start) fail('COMMAND_EXISTS');
  if (operation !== 'start' && !start) fail('UNKNOWN_ATTEMPT');
  const stop = operation === 'start' ? null : await journal.get(attemptId, STOP);
  if (operation === 'stop' && stop) fail('COMMAND_EXISTS');
  const token = operation === 'start' ? driverToken(env, client.config.token) : null;
  const details = token ? startDetails(env, client.config, token, attemptId) : start.details;
  if (details?.authorization_reference !== attemptId || details.versions_url !== client.config.versionsUrl) fail('ATTEMPT_PROVIDER_MISMATCH');

  if (operation === 'status') {
    let session;
    try {
      const discovery = await client.discover();
      session = await lookupSession(client, discovery, start);
    } catch { session = {state: 'LOOKUP_UNAVAILABLE'}; }
    return {attemptId, start: commandSummary(start), stop: commandSummary(stop), session};
  }
  const discovery = await client.discover();
  if (!discovery.endpoints['commands:RECEIVER'] || !discovery.endpoints['sessions:SENDER']) fail('COMMAND_OR_SESSION_MODULE_MISSING');
  const action = operation === 'start' ? START : STOP;
  const response_url = callbackOrigin(details.callback_origin) + '/ocpi/2.2.1/emsp/commands/' + action + '/' + attemptId;
  let payload;
  let record = details;
  if (action === START) {
    await verifyStartGun(client,discovery,await client.listLocations(discovery),details,publishedOnly,token,pilot);
    const {location_id, evse_uid, connector_id, authorization_reference} = details;
    payload = {response_url, token, location_id, evse_uid, connector_id, authorization_reference};
  } else {
    const session = await lookupSession(client, discovery, start);
    if (session.state !== 'MATCHED' || session.status !== 'ACTIVE') fail('NO_UNIQUE_MATCHING_ACTIVE_SESSION');
    payload = {response_url, session_id: session.id};
    record = {...details, session_id: session.id};
  }
  const routing = {fromCountryCode: details.from_country_code, fromPartyId: details.from_party_id,
    toCountryCode: details.country_code, toPartyId: details.party_id};
  try { validateOcpiCommand(client, discovery, action, payload, routing); }
  catch { fail('INVALID_COMMAND_TARGET_PAYLOAD_OR_TOKEN'); }
  await journal.reserve(attemptId, action, record);
  // The reservation survives interruptions, including a timeout after acceptance by the CPO.
  try {
    const response = await sendCommand(client, discovery, action, payload, routing);
    const saved = await journal.saveResponse(attemptId, action, response);
    return {attemptId, action, ack: response.result, timeoutSeconds: response.timeout,
      ...(saved?.respondedAt && {acknowledgedAt:saved.respondedAt})};
  } catch { fail('DELIVERY_OR_ACK_UNCERTAIN_CHECK_STATUS_WITH_SAME_UUID'); }
}

async function main() {
  const [operation, attemptId, ...extra] = process.argv.slice(2);
  if (extra.length || !['start', 'status', 'stop'].includes(operation) || !uuid.test(attemptId)) {
    fail('USAGE: start|status|stop <canonical-lowercase-uuid>');
  }
  const env = process.env;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.AFE_SANDBOX_PROJECT_ID || '') ||
      [env.GOOGLE_CLOUD_PROJECT, env.GCLOUD_PROJECT].some(id => id && id !== env.AFE_SANDBOX_PROJECT_ID)) {
    fail('INVALID_OR_MISMATCHED_SANDBOX_PROJECT_ID');
  }
  if (env.FIRESTORE_EMULATOR_HOST) fail('EMULATOR_NOT_ALLOWED_FOR_LIVE_OPERATOR');
  const [{Firestore}, {OcpiSandboxClient, loadOcpiSandboxConfig}, {OcpiCommandJournal}, {sendOcpiCommand}] =
    await Promise.all([import('@google-cloud/firestore'), import('./ocpi-sandbox-client.mjs'),
      import('./ocpi-command-journal.mjs'), import('./ocpi-sandbox-commands.mjs')]);
  const client = new OcpiSandboxClient(loadOcpiSandboxConfig(env));
  const db = new Firestore({projectId: env.AFE_SANDBOX_PROJECT_ID});
  try {
    const result = await runOcpiOperator(operation, attemptId, {client, journal: new OcpiCommandJournal(db),
      sendCommand: sendOcpiCommand, env});
    console.log(JSON.stringify(result));
  } finally { await db.terminate(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const message = error instanceof OperatorError ? error.message :
      error?.code === 'COMMAND_EXISTS' ? 'COMMAND_EXISTS' : 'FAILED_CHECK_SANDBOX_CONFIG_DATABASE_AND_VENDOR_ACCESS';
    console.error(message);
    process.exitCode = 1;
  });
}
