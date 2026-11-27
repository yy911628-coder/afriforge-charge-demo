import test from 'node:test';
import assert from 'node:assert/strict';
import {runOcpiOperator,verifyStartGun} from './ocpi-command-operator.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const attempt = '8fe091b3-7bc2-4c64-9b6e-20c99a734f5e';
const start = 'START_SESSION';
const stop = 'STOP_SESSION';
const appToken = {country_code: 'ZA', party_id: 'EMS', uid: 'SANDBOX-DRIVER', type: 'APP_USER',
  contract_id: 'SANDBOX-CONTRACT', issuer: 'Sandbox', valid: true, whitelist: 'NEVER', last_updated: '2026-11-24T00:00:00Z'};
const targetSession = {id: 'SESSION-7', status: 'ACTIVE', country_code: 'ZA', party_id: 'CPO',
  authorization_reference: attempt, location_id: 'L', evse_uid: 'E', connector_id: 'C', kwh: 1.25,
  cdr_token: {uid: 'SENSITIVE_SESSION_DATA'}};

test('site pilot verifies the reserved connector and its sole driver reservation before dispatch', async () => {
  const evse={uid:'E',status:'RESERVED',connectors:[{id:'C',standard:'IEC_62196_T2_COMBO'}]};
  const locations=[{publish:true,country_code:'ZA',party_id:'CPO',id:'L',evses:[evse]}];
  const own={...targetSession,status:'RESERVATION',cdr_token:appToken};
  let sessions=[];
  const client={listSenderModule:async()=>sessions};
  const verify=(token=appToken)=>verifyStartGun(client,{},locations,targetSession,true,token);
  await assert.rejects(verify(),/RESERVATION_UNVERIFIED/);
  for(const mismatch of [{cdr_token:{...appToken,uid:'another-driver'}},{connector_id:'D'},{status:'PENDING'},{end_date_time:'2026-11-25T00:00:00Z'}]){
    sessions=[{...own,...mismatch}];await assert.rejects(verify(),/RESERVATION_UNVERIFIED/);
  }
  sessions=[own,targetSession];await assert.rejects(verify(),/NOT_AVAILABLE/);
  sessions=[own];await verify();await assert.rejects(verify(null),/NOT_AVAILABLE/);
  evse.connectors[0].status='CHARGING';await assert.rejects(verify(),/NOT_AVAILABLE/);
  delete evse.connectors[0].status;
  evse.status='AVAILABLE';sessions=[];await verify();
  await assert.rejects(verify(null),/NOT_CONNECTED/);
  evse.vehicle_connected=false;await assert.rejects(verify(),/NOT_CONNECTED/);
});

test('Rivonia accepts plugged and available outlets without a reservation record', async () => {
  for (const uid of ['ZA41020001000001000100','ZA41020001000001000101']) {
    const target={country_code:'ZA',party_id:'AFE',location_id:'ZA41020001000001',evse_uid:uid,connector_id:uid+'01'};
    const connector={id:target.connector_id,standard:'IEC_62196_T2_COMBO'};
    const evse={uid,status:'RESERVED',connectors:[connector]};
    const locations=[{id:target.location_id,country_code:'ZA',party_id:'AFE',publish:true,evses:[evse]}];
    let sessions=[];
    const verify=()=>verifyStartGun({listSenderModule:async()=>sessions},{},locations,target,true,appToken,false);
    await verify();
    sessions=[{...target,id:'occupied',status:'ACTIVE'}];
    await assert.rejects(verify(),/NOT_AVAILABLE/);
    sessions=[{...target,id:'booking',status:'RESERVATION',cdr_token:{...appToken,uid:'other'}}];
    await assert.rejects(verify(),/RESERVATION_UNVERIFIED/);
    sessions=[];connector.status='CHARGING';await assert.rejects(verify(),/NOT_AVAILABLE/);
    delete connector.status;evse.status='AVAILABLE';await verify();
    evse.status='OUTOFORDER';await assert.rejects(verify(),/NOT_AVAILABLE/);
  }
});

function setup() {
  const records = new Map();
  const sessions = [];
  const posts = [];
  const locations = [{country_code: 'ZA', party_id: 'CPO', id: 'L', evses: [
    {uid: 'E', status: 'AVAILABLE', connectors: [{id: 'C', standard: 'IEC_62196_T2_COMBO'}]}
  ]}];
  const env = {AFE_OCPI_COMMAND_CALLBACK_ORIGIN: 'https://sandbox.example',
    AFE_OCPI_CPO_COUNTRY_CODE: 'ZA', AFE_OCPI_CPO_PARTY_ID: 'CPO', AFE_OCPI_LOCATION_ID: 'L',
    AFE_OCPI_EVSE_UID: 'E', AFE_OCPI_CONNECTOR_ID: 'C', AFE_OCPI_APP_USER_TOKEN_JSON: JSON.stringify(appToken)};
  const client = {config: {token: 'SECRET-TRANSPORT', versionsUrl: 'https://provider.example/versions'},
    checkedUrl(input) { return new URL(input); },
    async discover() { return {version: '2.2.1', endpoints: {'commands:RECEIVER': 'https://provider.example/c', 'sessions:SENDER': 'https://provider.example/s'}}; },
    async listLocations() { return locations; }, async listSenderModule(discovery, name, options) {
      assert.equal(name, 'sessions');
      assert.deepEqual(options, {dateFrom: '2026-11-24T08:20:01.000Z'});
      return sessions;
    }};
  const journal = {
    async get(id, action) { assert.equal(id, attempt); return records.get(action) || null; },
    async reserve(id, action, details) {
      assert.equal(id, attempt);
      if (records.has(action)) throw Object.assign(new Error('COMMAND_EXISTS'), {code: 'COMMAND_EXISTS'});
      records.set(action, {details: {...details}, createdAt: '2026-11-24T08:25:01.000Z'});
    },
    async saveResponse(id, action, response) { assert.equal(id, attempt); records.get(action).response = response; }
  };
  const deps = {client, journal, env, async sendCommand(client, discovery, action, payload, routing) {
    assert.ok(records.has(action));
    posts.push({action, payload, routing});
    return {result: 'ACCEPTED', timeout: 60};
  }};
  return {deps, locations, sessions, posts, records, run: op => runOcpiOperator(op, attempt, deps)};
}

test('start reserves first and pins callback origin, both parties and exact gun without persisting secrets', async () => {
  const {run, records, posts} = setup();
  const report = await run('start');
  assert.equal(report.ack, 'ACCEPTED');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].payload, {response_url: 'https://sandbox.example/ocpi/2.2.1/emsp/commands/START_SESSION/' + attempt,
    token: appToken, location_id: 'L', evse_uid: 'E', connector_id: 'C', authorization_reference: attempt});
  assert.deepEqual(posts[0].routing, {fromCountryCode: 'ZA', fromPartyId: 'EMS', toCountryCode: 'ZA', toPartyId: 'CPO'});
  assert.doesNotMatch(JSON.stringify([report, records.get(start)]), /SECRET-TRANSPORT|SANDBOX-DRIVER|SANDBOX-CONTRACT/);
  await assert.rejects(() => run('start'), /COMMAND_EXISTS/);
  assert.equal(posts.length, 1);
});

test('concurrent starts with one UUID issue at most one POST', async () => {
  const {run, posts} = setup();
  const outcomes = await Promise.allSettled([run('start'), run('start')]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(posts.length, 1);
});

test('mismatched CPO, location, EVSE, connector, standard, occupied and ambiguous targets never POST', async () => {
  const variants = [
    l => { l.country_code = 'TH'; }, l => { l.party_id = 'OTH'; }, l => { l.id += '-2'; }, l => { l.evses[0].uid = 'E2'; },
    l => { l.evses[0].connectors[0].id = 'C2'; }, l => { l.evses[0].connectors[0].standard = 'GBT_DC'; },
    l => { l.evses[0].status = 'CHARGING'; }, l => { l.evses.push({...l.evses[0]}); }
  ];
  for (const change of variants) {
    const {run, locations, posts} = setup();
    change(locations[0]);
    await assert.rejects(() => run('start'), /TARGET_/);
    assert.equal(posts.length, 0);
  }
});

test('requires HTTPS callback and valid distinct APP_USER token', async () => {
  for (const badToken of [{uid: 'SECRET-TRANSPORT'}, {valid: false}, {type: 'RFID'}, {whitelist: 'UNKNOWN'},
    {last_updated: '2026-02-31T00:00:00Z'}, {issuer: 'Field\nBreak'}]) {
    const {run, deps, posts, records} = setup();
    deps.env.AFE_OCPI_APP_USER_TOKEN_JSON = JSON.stringify({...appToken, ...badToken});
    await assert.rejects(() => run('start'), /TOKEN/);
    assert.equal(posts.length, 0);
    assert.equal(records.size, 0);
  }
  const {run, deps, posts} = setup();
  deps.env.AFE_OCPI_COMMAND_CALLBACK_ORIGIN = 'http://sandbox.example';
  await assert.rejects(() => run('start'), /CALLBACK_ORIGIN/);
  assert.equal(posts.length, 0);
});

test('CLI refuses emulator or wrong sandbox project before constructing any live client', () => {
  const file = fileURLToPath(new URL('./ocpi-command-operator.mjs', import.meta.url));
  for (const [patch, expected] of [
    [{FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'}, 'EMULATOR_NOT_ALLOWED_FOR_LIVE_OPERATOR'],
    [{GOOGLE_CLOUD_PROJECT: 'other-project'}, 'INVALID_OR_MISMATCHED_SANDBOX_PROJECT_ID'],
    [{AFE_SANDBOX_PROJECT_ID: '.'}, 'INVALID_OR_MISMATCHED_SANDBOX_PROJECT_ID']
  ]) {
    const env = {...process.env, AFE_SANDBOX_PROJECT_ID: 'sandbox-project', GCLOUD_PROJECT: '', GOOGLE_CLOUD_PROJECT: '',
      FIRESTORE_EMULATOR_HOST: '', ...patch};
    const result = spawnSync(process.execPath, [file, 'start', attempt], {env, encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), expected);
  }
});

test('timeout retains the attempt, and duplicate dispatch is forbidden even with missing acknowledgement', async () => {
  const {run, deps, posts} = setup();
  deps.sendCommand = async () => { posts.push(start); throw new Error('sensitive transport diagnostics'); };
  await assert.rejects(() => run('start'), /UNCERTAIN/);
  await assert.rejects(() => run('start'), /COMMAND_EXISTS/);
  assert.equal(posts.length, 1);
  const status = await run('status');
  assert.deepEqual(status.start, {ack: null, callback: null});
  assert.deepEqual(status.session, {state: 'NOT_FOUND'});
});

test('callback can beat ack and session publication; query reports each independently', async () => {
  const {run, deps, records, sessions} = setup();
  const sender = deps.sendCommand;
  deps.sendCommand = async (...args) => {
    records.get(start).result = {result: 'ACCEPTED'};
    assert.deepEqual((await run('status')).start, {ack: null, callback: 'ACCEPTED'});
    return sender(...args);
  };
  await run('start');
  assert.equal((await run('status')).session.state, 'NOT_FOUND');
  sessions.push(targetSession);
  const status = await run('status');
  assert.deepEqual(status.start, {ack: 'ACCEPTED', callback: 'ACCEPTED'});
  assert.deepEqual(status.session, {state: 'MATCHED', id: 'SESSION-7', status: 'ACTIVE', kwh: 1.25});
  assert.doesNotMatch(JSON.stringify(status), /SENSITIVE_SESSION_DATA|SANDBOX-DRIVER/);
  deps.client.listSenderModule = async () => { throw new Error('provider auth trace'); };
  assert.deepEqual((await run('status')).session, {state: 'LOOKUP_UNAVAILABLE'});
});

test('stop matches pin, reference, routing and all target fields; only one unique active session permits dispatch', async () => {
  const {run, deps, sessions, posts, records} = setup();
  await run('start');
  for (const field of ['authorization_reference', 'country_code', 'party_id', 'location_id', 'evse_uid', 'connector_id', 'status']) {
    sessions.splice(0, sessions.length, {...targetSession, [field]: 'OTHER'});
    await assert.rejects(() => run('stop'), /NO_UNIQUE_MATCHING_ACTIVE_SESSION/);
  }
  sessions.splice(0, sessions.length, targetSession, {...targetSession, id: 'SESSION-8'});
  await assert.rejects(() => run('stop'), /NO_UNIQUE_MATCHING_ACTIVE_SESSION/);
  assert.equal(posts.length, 1);
  sessions.splice(1);
  deps.env.AFE_OCPI_CONNECTOR_ID = 'OTHER';
  deps.env.AFE_OCPI_COMMAND_CALLBACK_ORIGIN = 'https://changed.example';
  delete deps.env.AFE_OCPI_APP_USER_TOKEN_JSON;
  const oldVersionsUrl = deps.client.config.versionsUrl;
  deps.client.config.versionsUrl += '-other';
  await assert.rejects(() => run('stop'), /PROVIDER_MISMATCH/);
  deps.client.config.versionsUrl = oldVersionsUrl;
  await run('stop');
  assert.deepEqual(posts[1].payload, {response_url: 'https://sandbox.example/ocpi/2.2.1/emsp/commands/STOP_SESSION/' + attempt,
    session_id: 'SESSION-7'});
  assert.equal(records.get(stop).details.session_id, 'SESSION-7');
  await assert.rejects(() => run('stop'), /COMMAND_EXISTS/);
  assert.equal(posts.length, 2);
});
