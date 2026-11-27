import {OcpiSandboxClient} from './ocpi-sandbox-client.mjs';
import {sendOcpiCommand, validToken} from './ocpi-sandbox-commands.mjs';
import {CommandJournalError, OcpiCommandJournal, validCommandKey} from './ocpi-command-journal.mjs';
import {requireAvailableGun, verifyStartGun, runOcpiOperator} from './ocpi-command-operator.mjs';
import {createOcpiCommandCallback, isCommandCallbackPath} from './ocpi-command-callback.mjs';
import {reserveWallet,notifyStarted} from './production-wallet.mjs';
import {loadProductionOcpiConfig,readRivoniaRate,walletRateFor} from './production-ocpi-stations.mjs';
import {accountTokenIssuer,accountDriverToken} from './production-ocpi-driver.mjs';
import {pilotSiteMatches} from './station-test-credit.mjs';

const keys = ['country_code','party_id','location_id','evse_uid','connector_id'];
const same = (a,b) => keys.every(key => typeof a?.[key] === 'string' && a[key] === b?.[key]);
const operations = new Map([
  ['/api/ocpi/command-capabilities','capabilities'], ['/api/ocpi/session-status','status'],
  ['/api/charge/start','start'], ['/api/ocpi/start-session','start'], ['/api/ocpi/stop-session','stop']
]);
const conflict = new Set(['TARGET_LOCATION_MISSING_OR_AMBIGUOUS','TARGET_EVSE_MISSING_OR_AMBIGUOUS',
  'TARGET_EVSE_NOT_AVAILABLE','TARGET_VEHICLE_NOT_CONNECTED','TARGET_RESERVATION_UNVERIFIED','TARGET_CCS2_CONNECTOR_NOT_CONFIRMED','TARGET_REMOTE_COMMANDS_UNAVAILABLE','NO_UNIQUE_MATCHING_ACTIVE_SESSION']);
function fail(status, code) { throw Object.assign(new Error(code),{status}); }

function configuredTargets(env) {
  const site = {country_code:env.AFE_PRODUCTION_OCPI_CPO_COUNTRY_CODE, party_id:env.AFE_PRODUCTION_OCPI_CPO_PARTY_ID,
    location_id:env.AFE_PRODUCTION_OCPI_LOCATION_ID};
  const id = value => typeof value==='string' && /^[!-~]{1,36}$/.test(value);
  if (!/^[A-Z]{2}$/.test(site.country_code || '') || !/^[A-Z0-9]{3}$/.test(site.party_id || '') || !id(site.location_id))
    fail(503,'PRODUCTION_COMMANDS_NOT_CONFIGURED');
  let pairs;
  try {
    pairs = env.AFE_PRODUCTION_OCPI_CONNECTORS_JSON === undefined
      ? [{evse_uid:env.AFE_PRODUCTION_OCPI_EVSE_UID,connector_id:env.AFE_PRODUCTION_OCPI_CONNECTOR_ID}]
      : JSON.parse(env.AFE_PRODUCTION_OCPI_CONNECTORS_JSON);
  } catch { fail(503,'PRODUCTION_COMMANDS_NOT_CONFIGURED'); }
  if (!Array.isArray(pairs) || !pairs.length) fail(503,'PRODUCTION_COMMANDS_NOT_CONFIGURED');
  const seen = new Set();
  return pairs.map(pair => {
    if (!pair || Object.keys(pair).length!==2 || !id(pair.evse_uid) || !id(pair.connector_id)) fail(503,'PRODUCTION_COMMANDS_NOT_CONFIGURED');
    const key = JSON.stringify([pair.evse_uid,pair.connector_id]);
    if (seen.has(key)) fail(503,'PRODUCTION_COMMANDS_NOT_CONFIGURED');
    seen.add(key);
    return {...site,evse_uid:pair.evse_uid,connector_id:pair.connector_id};
  });
}

function selectTarget(targets,requested) {
  const target = targets.find(t=>same(t,requested));
  if (!target) fail(403,'PRODUCTION_TARGET_MISMATCH');
  return target;
}

function commandIdentity(env,config) {
  const callback=URL.parse(env.AFE_PRODUCTION_SERVICE_ORIGIN);
  const inbound=env.AFE_PRODUCTION_OCPI_INBOUND_TOKEN;
  if (!/^[!-~]{1,64}$/.test(inbound || '') || callback?.protocol!=='https:' ||
      callback.href!==callback.origin+'/' || callback.hostname.includes('sandbox')) fail(503,'PRODUCTION_COMMANDS_NOT_CONFIGURED');
  const issuer = accountTokenIssuer(env);
  if (issuer) return {issuer, callbackOrigin:callback.origin};
  if (!env.AFE_PRODUCTION_OCPI_APP_USER_TOKEN_JSON) fail(503,'PRODUCTION_APP_USER_NOT_CONFIGURED');
  let appToken;
  try { appToken=JSON.parse(env.AFE_PRODUCTION_OCPI_APP_USER_TOKEN_JSON); }
  catch { fail(503,'PRODUCTION_COMMANDS_NOT_CONFIGURED'); }
  const credentials = [config.token,inbound].filter(Boolean).flatMap(v=>[v,Buffer.from(v).toString('base64')]);
  if (!validToken(appToken) || appToken.type !== 'APP_USER' ||
      [...Object.values(appToken),...Object.values(appToken.energy_contract ?? {})].some(v=>credentials.includes(v))) fail(503,'PRODUCTION_COMMANDS_NOT_CONFIGURED');
  return {appToken, callbackOrigin:callback.origin};
}

async function postedTarget(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) fail(415,'JSON_REQUIRED');
  const chunks = [];
  let bytes=0;
  for await (const chunk of req) {
    bytes+=chunk.length;
    if (bytes>2048) fail(413,'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  let body;
  try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400,'INVALID_COMMAND_TARGET'); }
  if (!body || Object.keys(body).length!==1 || !body.target || Object.keys(body.target).length!==keys.length ||
      keys.some(k => typeof body.target[k]!=='string' || !/^[!-~]{1,36}$/.test(body.target[k]))) fail(400,'INVALID_COMMAND_TARGET');
  return body.target;
}

function result(record) {
  return record ? {ack:record.response?.result ?? null,callback:record.result?.result ?? null,
    requestedAt:record.createdAt,...(record.respondedAt && {acknowledgedAt:record.respondedAt}),
    ...(record.completedAt && {callbackAt:record.completedAt})} : null;
}

async function commandDirectory(config,fetchImpl,wallet=false) {
  const ocpi=new OcpiSandboxClient(config,{fetchImpl,timeoutMs:10000});
  const discovery=await ocpi.discover({includeTariffs:wallet});
  if (!discovery.endpoints['commands:RECEIVER'] || !discovery.endpoints['sessions:SENDER']) fail(503,'PRODUCTION_COMMAND_MODULES_UNAVAILABLE');
  const locations=await ocpi.listLocations(discovery);
  return {ocpi,discovery,locations};
}

async function commandCapabilities(env,fetchImpl) {
  const config=loadProductionOcpiConfig(env);
  const configured=configuredTargets(env);
  const {locations}=await commandDirectory(config,fetchImpl);
  const targets=configured.filter(target=>{
    try { requireAvailableGun(locations,target,{publishedOnly:true,available:false}); return true; }
    catch (error) { if (conflict.has(error.message)) return false; throw error; }
  });
  if (!targets.length) return {enabled:false,targets};
  try { commandIdentity(env,config); }
  catch (error) {
    if (error.message==='PRODUCTION_APP_USER_NOT_CONFIGURED') return {enabled:false,targets,reason:error.message};
    throw error;
  }
  // Older clients understand one connector. New clients match the complete list.
  return {enabled:true,targets,target:targets[0]};
}

async function publicCommandTarget(env,fetchImpl,expectedTarget,wallet=false,driverUid=null) {
  const config=loadProductionOcpiConfig(env);
  const target=selectTarget(configuredTargets(env),expectedTarget);
  const identity=commandIdentity(env,config);
  const {ocpi,discovery,locations}=await commandDirectory(config,fetchImpl,wallet);
  const driverToken=driverUid && identity.issuer ? accountDriverToken(identity.issuer,driverUid) : identity.appToken;
  await verifyStartGun(ocpi,discovery,locations,target,true,driverToken,false);
  if(wallet){
    if(!discovery.endpoints['cdrs:SENDER'])fail(503,'WALLET_CDR_UNAVAILABLE');
    const site=locations.find(s=>s.country_code===target.country_code && s.party_id===target.party_id && s.id===target.location_id && s.publish===true);
    const evse=site.evses.find(e=>e.uid===target.evse_uid);
    const rate=walletRateFor(site,evse,evse.connectors.find(c=>c.id===target.connector_id),await readRivoniaRate(ocpi,discovery,target),target);
    if(rate?.status!=='verified')fail(409,'WALLET_TARIFF_UNVERIFIED');
    return rate;
  }
  return target;
}

export async function assertWalletTarget(env,target,fetchImpl,driverUid=null){
  try { return await publicCommandTarget(env,fetchImpl,target,true,driverUid); }
  catch(error) {
    if(conflict.has(error.message))fail(409,error.message);
    if(error.message==='TARGET_RESERVATION_LOOKUP_UNAVAILABLE')fail(503,error.message);
    throw error;
  }
}

export async function assertProductionChargeTarget(env,target,fetchImpl=fetch) {
  if (!same(target,target)) fail(400,'INVALID_COMMAND_TARGET');
  try { return await publicCommandTarget(env,fetchImpl,target); }
  catch (error) {
    if (conflict.has(error.message)) fail(409,error.message);
    if (error.status && /^[A-Z0-9_]+$/.test(error.message)) throw error;
    fail(503,'PRODUCTION_OCPI_UNAVAILABLE');
  }
}

export function createProductionChargeHandler({db,env,authorize,fetchImpl=fetch}) {
  const journal = new OcpiCommandJournal(db,'afe_production_ocpi_commands');
  function client() {
    return new OcpiSandboxClient(loadProductionOcpiConfig(env),{fetchImpl,timeoutMs:10000});
  }
  async function evidence(grant,session) {
    const [start,stop] = await Promise.all([journal.get(grant.attemptId,'START_SESSION'),journal.get(grant.attemptId,'STOP_SESSION')]);
    if ((start && !same(start.details,grant.target)) || (stop && !same(stop.details,grant.target))) fail(409,'PRODUCTION_TARGET_MISMATCH');
    if (grant.uid && (['REJECTED','NOT_SUPPORTED'].includes(start?.response?.result) ||
        ['REJECTED','FAILED'].includes(start?.result?.result) ||
        (session?.state==='MATCHED' && ['COMPLETED','INVALID'].includes(session.status)))) {
      const account=db.collection('users').doc(grant.uid);
      await db.runTransaction(async tx=>{
        if ((await tx.get(account)).data()?.activeCharge===grant.attemptId) tx.update(account,{activeCharge:null});
      });
    }
    let wallet;
    if(['wallet','card'].includes(grant.funding) && grant.uid){
      if(session?.state==='MATCHED' && session.status==='ACTIVE')await notifyStarted(db,grant.uid,grant.attemptId);
      const order=(await db.collection('users').doc(grant.uid).collection('orders').doc(grant.attemptId).get()).data();
      if(order)wallet={settlement:order.settlement,lowBalanceStop:order.lowBalanceStop===true,costCents:order.costCents??null,
        shortfallCents:order.shortfallCents??null,energyKwh:order.energyKwh??null,operatorReviewCents:order.operatorReviewCents??null,
        estimatedCents:session?.state==='MATCHED' && Number.isFinite(session.kwh)?
          Math.round(session.kwh*Number(grant.tariff.total_per_kwh)*100):null};
    }
    return {attemptId:grant.attemptId,target:grant.target,canCommand:grant.readOnly===false,
      start:result(start),stop:result(stop),session,...(wallet && {funding:grant.funding,wallet})};
  }
  async function handle(operation,pass,target) {
    const grant = await authorize(pass,operation === 'stop' ? 'stop' : 'status');
    if (!validCommandKey(grant?.attemptId,'START_SESSION') || !same(grant.target,grant.target)) fail(403,'INVALID_PRODUCTION_GRANT');
    if (target && !same(target,grant.target)) fail(403,'PRODUCTION_TARGET_MISMATCH');
    const start = await journal.get(grant.attemptId,'START_SESSION');
    if (start && !same(start.details,grant.target)) fail(409,'PRODUCTION_TARGET_MISMATCH');
    if (grant.recoveryOnly && !start) fail(403,'PRODUCTION_PASS_EXPIRED');
    if (operation === 'status' && !start) return evidence(grant,{state:'NOT_STARTED'});
    if (operation !== 'status' && grant.readOnly !== false) fail(403,'ORIGINAL_OPERATOR_PASS_REQUIRED');
    if (operation === 'stop' && !start) fail(409,'CHARGE_NOT_STARTED');
    const action = operation === 'stop' ? 'STOP_SESSION' : 'START_SESSION';
    // A duplicate submit, including after loss of the first HTTP response,
    // returns the durable attempt. No second command is transmitted.
    if (operation !== 'status' && await journal.get(grant.attemptId,action)) return evidence(grant,{state:'NOT_CHECKED'});
    let ocpi;
    try { ocpi = client(); } catch {
      if (operation==='status') return evidence(grant,{state:'LOOKUP_UNAVAILABLE'});
      fail(503,'PRODUCTION_OCPI_NOT_CONFIGURED');
    }
    let operatorEnv = {}, pilot=false;
    if (operation==='start') {
      const selected=selectTarget(configuredTargets(env),grant.target);
      const identity=commandIdentity(env,ocpi.config);
      const paid = await authorize(pass,'start');
      if (paid.readOnly!==false || paid.attemptId!==grant.attemptId || paid.uid!==grant.uid || !same(paid.target,grant.target)) fail(403,'PRODUCTION_GRANT_MISMATCH');
      let token = identity.appToken;
      if (identity.issuer) {
        if (typeof paid.uid!=='string' || !paid.uid) fail(403,'PRODUCTION_DRIVER_ACCOUNT_REQUIRED');
        const account = (await db.collection('users').doc(paid.uid).get()).data();
        if (!account || account.deleting) fail(403,'PRODUCTION_DRIVER_ACCOUNT_REQUIRED');
        token = accountDriverToken(identity.issuer,paid.uid,account.createdAt);
        pilot=paid.funding==='wallet' && paid.useTestCredit===true && pilotSiteMatches(selected);
      }
      operatorEnv={AFE_OCPI_APP_USER_TOKEN_JSON:JSON.stringify(token),AFE_OCPI_COMMAND_CALLBACK_ORIGIN:identity.callbackOrigin,
        AFE_OCPI_CPO_COUNTRY_CODE:selected.country_code,AFE_OCPI_CPO_PARTY_ID:selected.party_id,
        AFE_OCPI_LOCATION_ID:selected.location_id,AFE_OCPI_EVSE_UID:selected.evse_uid,AFE_OCPI_CONNECTOR_ID:selected.connector_id};
    }
    try {
      const scoped=Object.create(journal);
      if (grant.uid) scoped.reserve=(id,verb,details)=>journal.reserve(id,verb,details,db.collection('users').doc(grant.uid),
        ['wallet','card'].includes(grant.funding) ? (tx,driver)=>reserveWallet(tx,db,driver,grant,env) : undefined);
      const reply = await runOcpiOperator(operation,grant.attemptId,{client:ocpi,journal:scoped,env:operatorEnv,
        sendCommand:sendOcpiCommand,publishedOnly:true,pilot});
      return evidence(grant,operation === 'status' ? reply.session : {state:'NOT_CHECKED'});
    } catch (error) {
      if(error.publicCode)throw error;
      if(error.message==='TARGET_RESERVATION_LOOKUP_UNAVAILABLE')fail(503,error.message);
      if (operation === 'status') return evidence(grant,{state:'LOOKUP_UNAVAILABLE'});
      if (error.code === 'COMMAND_EXISTS' || error.message === 'COMMAND_EXISTS') return evidence(grant,{state:'NOT_CHECKED'});
      if (error.code==='ACCOUNT_CHARGE_UNAVAILABLE' || conflict.has(error.message)) fail(409,error.code==='ACCOUNT_CHARGE_UNAVAILABLE'?error.code:error.message);
      if (error.message === 'DELIVERY_OR_ACK_UNCERTAIN_CHECK_STATUS_WITH_SAME_UUID') fail(503,'OCPI_DELIVERY_UNCERTAIN');
      fail(503,'PRODUCTION_COMMAND_SERVICE_UNAVAILABLE');
    }
  }
  return async (req,res) => {
    const json = (status,data) => {
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({environment:'production',...data}));
    };
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    try {
      if (isCommandCallbackPath(req.url)) {
        const inboundToken = env.AFE_PRODUCTION_OCPI_INBOUND_TOKEN;
        if (!/^[!-~]{1,64}$/.test(inboundToken || '')) {
          res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({status_code:3000,status_message:'Callback unavailable',timestamp:new Date().toISOString()}));
          return;
        }
        const callbacks = {async saveResult(id,action,value) {
          const record = await journal.get(id,action);
          if (!record) throw new CommandJournalError('UNKNOWN_COMMAND');
          // The direct CPO credential and correlated response_url identify the
          // request. When OCPI route headers are sent, they must identify the same parties.
          const routes = {'ocpi-from-country-code':'country_code','ocpi-from-party-id':'party_id',
            'ocpi-to-country-code':'from_country_code','ocpi-to-party-id':'from_party_id'};
          for (const [header,key] of Object.entries(routes)) {
            if (req.headers[header] !== undefined && (req.headers[header] !== record.details[key] ||
                req.headersDistinct?.[header]?.length > 1)) throw new CommandJournalError('UNKNOWN_COMMAND');
          }
          return journal.saveResult(id,action,value);
        }};
        return await createOcpiCommandCallback({journal:callbacks,inboundToken})(req,res);
      }
      const operation = operations.get(req.url);
      if (!operation) return json(404,{error:'NOT_FOUND'});
      res.setHeader('Vary','Origin');
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(env.AFE_PRODUCTION_APP_ORIGIN).origin; } catch {}
        if (!origin || req.headers.origin!==origin) fail(403,'ORIGIN_DENIED');
        res.setHeader('Access-Control-Allow-Origin',origin);
      }
      const method = ['start','stop'].includes(operation) ? 'POST' : 'GET';
      if (req.method==='OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods',method+', OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','Accept, Authorization, Content-Type');
        res.writeHead(204).end(); return;
      }
      if (req.method!==method) { res.setHeader('Allow',method); return json(405,{error:'METHOD_NOT_ALLOWED'}); }
      if (operation==='capabilities') {
        try {
          return json(200,await commandCapabilities(env,fetchImpl));
        } catch { return json(200,{enabled:false}); }
      }
      const match=req.afeOrderPass ? [null,req.afeOrderPass] : /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
      if (!match || (req.headersDistinct && req.headersDistinct.authorization?.length!==1)) fail(401,'PRODUCTION_OPERATOR_PASS_REQUIRED');
      const target=method==='POST' ? await postedTarget(req) : null;
      return json(200,await handle(operation,match[1],target));
    } catch (error) {
      req.resume();
      const known=Number.isInteger(error.status) && error.status>=400 && error.status<=599 && /^[A-Z0-9_]{1,80}$/.test(error.message);
      return json(known ? error.status : 503,{error:known ? error.message : 'PRODUCTION_COMMAND_SERVICE_UNAVAILABLE'});
    }
  };
}
