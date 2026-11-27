import {createRemoteJWKSet,jwtVerify} from 'jose';
import {FieldValue} from '@google-cloud/firestore';
import {OcpiCommandJournal} from './ocpi-command-journal.mjs';
import {runOcpiOperator} from './ocpi-command-operator.mjs';
import {OcpiSandboxClient} from './ocpi-sandbox-client.mjs';
import {sendOcpiCommand} from './ocpi-sandbox-commands.mjs';
import {loadProductionOcpiConfig} from './production-ocpi-stations.mjs';
import {sameWalletTarget,settleWallet,notifyStarted} from './production-wallet.mjs';
import {reject} from './accounts.mjs';
import {pilotBudget} from './station-test-credit.mjs';

const jwks=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const minute=60000;
export async function schedulerAuth(req,env) {
  const auth=/^Bearer ([A-Za-z0-9_.-]{32,4096})$/.exec(req.headers.authorization || '');
  if(!auth || req.headersDistinct?.authorization?.length>1)reject(401,'SCHEDULER_AUTH_REQUIRED');
  const expected='afe-wallet-monitor@'+env.AFE_PRODUCTION_PROJECT_ID+'.iam.gserviceaccount.com';
  try {
    const {payload}=await jwtVerify(auth[1],jwks,{issuer:'https://accounts.google.com',audience:env.AFE_PRODUCTION_SERVICE_ORIGIN+'/internal/wallet/reconcile',algorithms:['RS256']});
    if(payload.email_verified!==true || payload.email!==expected)throw new Error();
  }catch{reject(403,'SCHEDULER_AUTH_REQUIRED');}
}
export function stopForBalance(charge,session,balance,now=Date.now()) {
  if(session.state!=='MATCHED' || session.status!=='ACTIVE')return false;
  const rate=Number(charge.tariff.total_per_kwh),kwh=session.kwh??0;
  if(!Number.isFinite(rate) || rate<=0 || !Number.isFinite(kwh) || kwh<0)return false;
  // The site is rated 120 kW. Budget for one minute between checks and one for the stop to propagate.
  const created=Date.parse(charge.createdAt),sample=Date.parse(session.updatedAt);
  const observed=Number.isFinite(sample) && session.kwh!=null?Math.max(created,Math.min(sample,now)):created;
  const lagHours=(Math.max(0,now-observed)+2*minute)/3600000;
  return balance<=Math.ceil((kwh+120*lagHours)*rate*100);
}

export function walletMonitor({db,env,wallet,settlement,fetchImpl=fetch,operator=runOcpiOperator,clientFactory=()=>new OcpiSandboxClient(loadProductionOcpiConfig(env),{fetchImpl,timeoutMs:10000})}) {
  const journal=new OcpiCommandJournal(db,'afe_production_ocpi_commands');
  async function checkCharge(ref,charge) {
    const id=ref.id,user=db.collection('users').doc(charge.uid),order=user.collection('orders').doc(id);
    if(charge.state==='CARD_PENDING')return settlement.reconcile(ref,charge);
    if(charge.state==='CLOSED_UNCONFIRMED'){
      if(charge.reviewCdrId)return;
      const client=clientFactory(), discovery=await client.discover();
      const bills=await client.listSenderModule(discovery,'cdrs',{dateFrom:new Date(Date.parse(charge.createdAt)-5*minute).toISOString()});
      const matches=bills.filter(c=>c?.authorization_reference===id && c.country_code===charge.target.country_code && c.party_id===charge.target.party_id);
      if(matches.length>1)reject(409,'WALLET_CDR_REVIEW');
      if(matches.length)await settleWallet(db,id,matches[0]);
      return;
    }
    const [start,account]=await Promise.all([journal.get(id,'START_SESSION'),user.get()]);
    if(!start || start.details.authorization_reference!==id || !sameWalletTarget(charge.target,start.details) || account.data()?.walletCharge!==id) return;
    if(['REJECTED','NOT_SUPPORTED'].includes(start.response?.result) ||
      ['REJECTED','FAILED','EVSE_OCCUPIED','EVSE_INOPERATIVE','NOT_SUPPORTED'].includes(start.result?.result)){
      return db.runTransaction(async tx=>{
        const [driver,state]=await tx.getAll(user,ref);
        if(driver.data()?.walletCharge!==id || state.data()?.state!=='ACTIVE')return;
        tx.update(user,{walletCharge:null,...(driver.data().activeCharge===id && {activeCharge:null})});
        tx.update(ref,{state:'REJECTED',nextCheckAt:FieldValue.delete()});
        tx.update(order,{settlement:'REJECTED'});
      });
    }
    const client=clientFactory(),args={client,journal,env:{},sendCommand:sendOcpiCommand,publishedOnly:true};
    const {session}=await operator('status',id,args);
    if(session.state==='MATCHED'){
      if(charge.sessionId && charge.sessionId!==session.id)reject(409,'WALLET_SESSION_MISMATCH');
      if(!charge.sessionId)await ref.update({sessionId:session.id});
      if(session.status==='ACTIVE'){
        await notifyStarted(db,charge.uid,id);
        const budget=charge.creditReference ? pilotBudget(account.data(),charge.uid,charge.target) : account.data().walletCents??0;
        if(charge.funding!=='card' && stopForBalance(charge,session,budget) && !(await journal.get(id,'STOP_SESSION'))){
          await order.update({lowBalanceStop:true});
          // The ordinary STOP path again checks the exact ACTIVE session and atomically reserves the command.
          try{await operator('stop',id,args);}catch(e){if(!['COMMAND_EXISTS','NO_UNIQUE_MATCHING_ACTIVE_SESSION'].includes(e.code||e.message))throw e;}
        }
        return;
      }
    }
    const discovery=await client.discover();
    const cdrs=await client.listSenderModule(discovery,'cdrs',{dateFrom:new Date(Date.parse(start.createdAt)-5*minute).toISOString()});
    const matching=cdrs.filter(c=>c?.authorization_reference===id && c.country_code===charge.target.country_code && c.party_id===charge.target.party_id);
    if(!matching.length){
      if(session.state==='MATCHED' && ['INVALID','COMPLETED'].includes(session.status))await db.runTransaction(async tx=>{
        if((await tx.get(ref)).data()?.state==='ACTIVE')tx.update(order,{settlement:'AWAITING_CDR'});
      });
      return;
    }
    if(matching.length!==1 || matching[0].credit)reject(409,'WALLET_CDR_REVIEW');
    if(settlement)await settlement.accept(matching[0]);
    else await settleWallet(db,id,matching[0]);
  }
  async function tick(){
    const heartbeat=db.collection('afe_wallet_monitor').doc('heartbeat');
    const now=new Date().toISOString();
    async function work(collection,fn,delay){
      const due=await db.collection(collection).where('nextCheckAt','<=',now).orderBy('nextCheckAt').limit(12).get();
      const outcomes=await Promise.allSettled(due.docs.map(async doc=>{
        // Lease in the same transaction as reading the work item. A lost worker is retried next minute.
        const item=await db.runTransaction(async tx=>{
          const current=(await tx.get(doc.ref)).data();
          if(!current?.nextCheckAt || current.nextCheckAt>now)return null;
          const interval=current.state==='CLOSED_UNCONFIRMED'?24*60*minute:delay;
          tx.update(doc.ref,{nextCheckAt:new Date(Date.now()+interval).toISOString()});return current;
        });
        if(item)await fn(doc.ref,item);
      }));
      for(const r of outcomes)if(r.status==='rejected'){
        const reason=r.reason?.publicCode;
        console.warn(JSON.stringify({component:'walletReconciliation',collection,error:/^[A-Z_]{1,60}$/.test(reason||'')?reason:'PROVIDER_CHECK_PENDING'}));
      }
    }
    await Promise.all([work('afe_wallet_charges',checkCharge,45000),work('afe_wallet_topups',(ref)=>wallet.reconcile(ref.id),5*minute)]);
    await heartbeat.set({checkedAt:new Date().toISOString()});
  }
  return {tick,checkCharge};
}
