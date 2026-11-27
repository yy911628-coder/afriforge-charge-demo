import {mandateVersion} from './direct-card.mjs';
import {randomBytes} from 'node:crypto';
import {FieldValue} from '@google-cloud/firestore';
import {hash, reject, uuid} from './accounts.mjs';
import {createWalletCheckout, loadProductionPeachConfig, queryProductionStatus} from './production-peach-provider.mjs';
import {parseCheckoutForm} from './peach-webhook.mjs';
import {verifySignature} from './peach.mjs';
import {pilotBudget,pilotCreditView,pilotRef,settlePilotCredit} from './station-test-credit.mjs';

const keys=['country_code','party_id','location_id','evse_uid','connector_id'];
export const sameWalletTarget=(a,b)=>keys.every(k=>typeof a?.[k]==='string' && a[k]===b?.[k]);
const stamp=()=>new Date().toISOString();
const refPattern=/^[0-9a-f]{16}$/;
const due=(ms)=>new Date(Date.now()+ms).toISOString();
export function amountInCents(value) {
  if(typeof value!=='string' || !/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(value)) reject(400,'INVALID_WALLET_AMOUNT');
  const [whole,fraction='']=value.split('.');
  return Number(whole)*100+Number(fraction.padEnd(2,'0'));
}
export const rand=cents=>(cents/100).toFixed(2);
function net(driver) {
  const cents=driver.walletCents??0;
  if(!Number.isSafeInteger(cents)) reject(409,'WALLET_REVIEW_REQUIRED');
  return cents;
}
function post(tx,user,driver,entry,id) {
  const after=net(driver)+entry.deltaCents;
  if(!Number.isSafeInteger(after)) reject(409,'WALLET_REVIEW_REQUIRED');
  tx.create(user.collection('walletLedger').doc(id),{...entry,createdAt:stamp(),balanceCents:Math.max(0,after),dueCents:Math.max(0,-after)});
  tx.update(user,{walletCents:after});
}
export function walletFloor(env) {
  const minimum=amountInCents(env.AFE_WALLET_MIN_START_ZAR??'50.00');
  if(minimum<=0) reject(503,'WALLET_MINIMUM_NOT_CONFIGURED');
  return minimum;
}
function allowed(driver,minimum,funding='wallet',uid,target,testCredit) {
  if(testCredit && funding!=='wallet') reject(400,'INVALID_CHARGE_INTENT');
  if(!driver || driver.deleting) reject(409,'ACCOUNT_UNAVAILABLE');
  if(driver.walletCharge) reject(409,'WALLET_CHARGE_UNSETTLED');
  if(funding==='card' && driver.unpaidCardCents>0)reject(409,'CARD_PAYMENT_OUTSTANDING');
  if(funding==='wallet'){
    const balance=testCredit ? pilotBudget(driver,uid,target) : net(driver);
    if(balance<=minimum) reject(409,'WALLET_BALANCE_TOO_LOW');
  }
}
function monitorFresh(data) {
  const age=Date.now()-Date.parse(data?.checkedAt);
  if(!(age>=0 && age<180000)) reject(503,'WALLET_MONITOR_UNAVAILABLE');
}
export function usableCard(card){
  if(card?.provider!=='peach-direct' || card.consent!==mandateVersion || !card.cardToken || !card.firstTransaction || !/^\d{4}$/.test(card.last4 || ''))reject(409,'LINK_CARD_FIRST');
  return card;
}
export async function reserveWallet(tx,db,driver,grant,env) {
  allowed(driver,walletFloor(env),grant.funding,grant.uid,grant.target,grant.useTestCredit);
  monitorFresh((await tx.get(db.collection('afe_wallet_monitor').doc('heartbeat'))).data());
  const ref=db.collection('afe_wallet_charges').doc(grant.attemptId);
  const selected=grant.funding==='card'?usableCard((await tx.get(db.collection('users').doc(grant.uid).collection('cards').doc(grant.cardId))).data()):null;
  tx.create(ref,{funding:grant.funding || 'wallet',...(grant.useTestCredit && {creditReference:pilotRef}),...(selected && {cardId:grant.cardId,last4:selected.last4}),uid:grant.uid,target:grant.target,tariff:grant.tariff,createdAt:stamp(),nextCheckAt:stamp(),state:'ACTIVE'});
  const user=db.collection('users').doc(grant.uid);
  tx.update(user,{walletCharge:grant.attemptId});
  tx.update(user.collection('orders').doc(grant.attemptId),{settlement:'IN_PROGRESS'});
}
export function createWallet({db,env,fetchImpl=fetch,initiate=createWalletCheckout,lookup=queryProductionStatus,checkWalletTarget,checkoutOrigin='https://secure.peachpayments.com'}) {
  const topups=db.collection('afe_wallet_topups'),grants=db.collection('afe_production_peach_grants');
  const userRef=uid=>db.collection('users').doc(uid);
  function merchant() {
    try {return loadProductionPeachConfig(env,{requireAmount:false});} catch {reject(503,'WALLET_TOPUP_NOT_CONFIGURED');}
  }
  function returnApp() {
    const url=new URL(env.AFE_PRODUCTION_APP_URL || 'https://yy911628-coder.github.io/afriforge-charge-demo/');
    if(url.protocol!=='https:' || url.origin!==env.AFE_PRODUCTION_APP_ORIGIN || url.username || url.password || url.search || url.hash) reject(503,'PRODUCTION_APP_URL_INVALID');
    return url;
  }
  function topupView(id,order) {
    return {id,amount:order.amount,status:order.status,createdAt:order.createdAt,...(order.status==='PENDING' && order.redirect && {redirect_url:order.redirect})};
  }
  async function view(uid) {
    const user=userRef(uid);
    const [driver,ledger]=await Promise.all([user.get(),user.collection('walletLedger').orderBy('createdAt','desc').limit(30).get()]);
    const data=driver.data();
    if(!data || data.deleting) reject(409,'ACCOUNT_UNAVAILABLE');
    let topupEnabled=true;
    try{merchant();}catch{topupEnabled=false;}
    const open=data.walletTopup && (await topups.doc(data.walletTopup).get()).data();
    const cents=net(data),minimum=walletFloor(env);
    const credit=pilotCreditView(data,uid);
    return {currency:'ZAR',balanceCents:Math.max(0,cents),dueCents:Math.max(0,-cents),minimumCents:minimum,
      ...(credit && {testCredit:{...credit,canFundCharge:credit.remainingCents>minimum && !data.walletCharge && !data.activeCharge}}),
      canFundCharge:cents>minimum && !data.walletCharge && !data.activeCharge,topupEnabled,
      pendingTopup:open && open.uid===uid?topupView(data.walletTopup,open):null,entries:ledger.docs.map(doc=>doc.data())};
  }
  async function topup(uid,{requestId,amount}) {
    const config=merchant();returnApp();
    if(!uuid(requestId)) reject(400,'INVALID_TOPUP_REQUEST');
    const cents=amountInCents(amount);
    if(cents<=0) reject(400,'INVALID_WALLET_AMOUNT');
    const reference=hash('afe-wallet-db:'+uid+':'+requestId).slice(0,16),state=randomBytes(32).toString('base64url');
    const ref=topups.doc(reference),user=userRef(uid),merchantId=hash(config.entityId);
    const held=await db.runTransaction(async tx=>{
      const [account,prior]=await tx.getAll(user,ref),driver=account.data();
      if(!driver || driver.deleting) reject(409,'ACCOUNT_UNAVAILABLE');
      if(prior.exists){
        const order=prior.data();
        if(order.uid!==uid || order.amount!==rand(cents) || order.merchant!==merchantId) reject(409,'TOPUP_REQUEST_CHANGED');
        return order;
      }
      if(driver.walletTopup) reject(409,'WALLET_TOPUP_PENDING');
      tx.create(ref,{uid,merchant:merchantId,amount:rand(cents),currency:'ZAR',paymentType:'DB',stateHash:hash(state),
        status:'PENDING',createdAt:stamp(),nextCheckAt:due(60000)});
      tx.update(user,{walletTopup:reference});
      return null;
    });
    if(held)return topupView(reference,held);
    // Only the transaction winner can create the provider checkout, even after an ambiguous timeout.
    let checkout;
    try {checkout=await initiate(config,{reference,returnState:state,paymentType:'DB',amount:rand(cents)},fetchImpl);}
    catch {reject(503,'TOPUP_DELIVERY_UNCONFIRMED');}
    const redirect=URL.parse(checkout?.redirectUrl);
    if(checkout?.reference!==reference || redirect?.origin!==checkoutOrigin || redirect.username || redirect.password || redirect.hash) reject(502,'INVALID_CHECKOUT_URL');
    await ref.update({redirect:redirect.href});
    return topupView(reference,(await ref.get()).data());
  }
  async function reconcile(reference,uid) {
    if(!refPattern.test(reference)) reject(404,'TOPUP_NOT_FOUND');
    const ref=topups.doc(reference),order=(await ref.get()).data();
    if(!order || (uid && order.uid!==uid)) reject(404,'TOPUP_NOT_FOUND');
    if(order.status==='PAID') return topupView(reference,order);
    const config=merchant();
    if(order.merchant!==hash(config.entityId))reject(409,'TOPUP_MERCHANT_MISMATCH');
    let result;
    try {result=await lookup(config,reference,fetchImpl,order.amount,'DB');} catch {reject(503,'TOPUP_STATUS_UNCONFIRMED');}
    if(!result?.verified || result.amount!==order.amount || result.currency!=='ZAR' || result.paymentType!=='DB' || result.reference!==reference)
      reject(409,'TOPUP_RECEIPT_MISMATCH');
    if(!['PAID','DECLINED','CANCELLED'].includes(result.status))return topupView(reference,order);
    return db.runTransaction(async tx=>{
      const user=userRef(order.uid),[cur,acct]=await tx.getAll(ref,user),current=cur.data(),driver=acct.data();
      if(current.status==='PAID')return topupView(reference,current);
      if(current.merchant!==order.merchant || current.uid!==order.uid || current.amount!==order.amount) reject(409,'TOPUP_RECEIPT_MISMATCH');
      if(!driver || driver.deleting) reject(409,'ACCOUNT_UNAVAILABLE');
      if(result.status==='PAID'){
        if(!/^[a-f0-9]{32}$/i.test(result.paymentId??''))reject(409,'TOPUP_RECEIPT_MISMATCH');
        const receipt=db.collection('afe_wallet_peach_receipts').doc(hash(order.merchant+':'+result.paymentId.toLowerCase()));
        if((await tx.get(receipt)).exists)reject(409,'TOPUP_RECEIPT_ALREADY_USED');
        const cents=amountInCents(current.amount);
        post(tx,user,driver,{kind:'TOPUP',reference,deltaCents:cents,repaidCents:Math.min(cents,Math.max(0,-net(driver)))},'topup-'+reference);
        tx.create(receipt,{reference,createdAt:stamp()});
      }
      tx.update(ref,{status:result.status,checkedAt:stamp(),nextCheckAt:FieldValue.delete(),redirect:FieldValue.delete()});
      if(driver.walletTopup===reference)tx.update(user,{walletTopup:null});
      return topupView(reference,{...current,status:result.status});
    });
  }
  async function notification(state,raw,contentType,browserReturn) {
    const config=merchant();
    let form;
    try{form=parseCheckoutForm(raw,contentType);}catch{reject(400,'INVALID_PEACH_NOTIFICATION');}
    if(!verifySignature(form,config.secret) || !refPattern.test(form.merchantTransactionId || ''))reject(403,'INVALID_PEACH_NOTIFICATION');
    const ref=form.merchantTransactionId,order=(await topups.doc(ref).get()).data();
    if(!order || form.paymentType!=='DB' || form.currency!=='ZAR' || form.amount!==order.amount ||
       (browserReturn && (!/^[\w-]{43}$/.test(state || '') || hash(state)!==order.stateHash)))reject(409,'TOPUP_RECEIPT_MISMATCH');
    try{await reconcile(ref);}catch(e){if(!browserReturn || e.publicCode!=='TOPUP_STATUS_UNCONFIRMED')throw e;}
    if(browserReturn){const dest=returnApp();dest.searchParams.set('account','wallet');return dest.href;}
  }
  async function issue(target,{uid,vehicleId,requestId,funding='wallet',cardId=null,useTestCredit=false}) {
    if(typeof useTestCredit!=='boolean' || (useTestCredit && funding!=='wallet'))reject(400,'INVALID_CHARGE_INTENT');
    if(!['wallet','card'].includes(funding) || (funding==='card' && !/^[a-f0-9]{64}$/.test(cardId || '')) || !uuid(requestId) || !uuid(vehicleId) || !sameWalletTarget(target,target) || Object.keys(target).length!==keys.length ||
      keys.some(k=>!(/^[!-~]{1,36}$/).test(target[k])))reject(400,'INVALID_CHARGE_INTENT');
    const user=userRef(uid),hex=hash(funding+':'+uid+':'+requestId);
    const id=[hex.slice(0,8),hex.slice(8,12),'4'+hex.slice(13,16),'8'+hex.slice(17,20),hex.slice(20,32)].join('-');
    const index=user.collection('orders').doc(id);
    function restore(order){
      if(!!order.useTestCredit!==useTestCredit || (funding==='card' && order.cardId!==cardId) || order.vehicleId!==vehicleId || !sameWalletTarget(order.target,target))reject(409,'ORDER_INTENT_CHANGED');
      return {pass:order.pass,attemptId:id,funding,target,vehicleId,...(useTestCredit && {useTestCredit:true})};
    }
    const prior=(await index.get()).data();if(prior)return restore(prior);
    allowed((await user.get()).data(),walletFloor(env),funding,uid,target,useTestCredit);
    monitorFresh((await db.collection('afe_wallet_monitor').doc('heartbeat').get()).data());
    const tariff=await checkWalletTarget(env,target,fetchImpl,uid);
    const pass=randomBytes(32).toString('base64url');
    return db.runTransaction(async tx=>{
      const [driver,car,existing]=await tx.getAll(user,user.collection('vehicles').doc(vehicleId),index);
      if(existing.exists)return restore(existing.data());
      allowed(driver.data(),walletFloor(env),funding,uid,target,useTestCredit);
      if(funding==='card')usableCard((await tx.get(user.collection('cards').doc(cardId))).data());
      if(!car.exists) reject(400,'VEHICLE_NOT_FOUND');
      const grant={uid,vehicleId,attemptId:id,target,tariff,funding,...(useTestCredit && {useTestCredit:true}),...(funding==='card' && {cardId}),createdAt:stamp(),expiresAt:due(30*60000),readUntil:due(48*3600000),readOnly:false};
      tx.create(grants.doc(hash(pass)),grant);
      tx.create(index,{pass,target,vehicleId,funding,...(useTestCredit && {useTestCredit:true}),...(funding==='card' && {cardId}),createdAt:grant.createdAt,settlement:'NOT_STARTED'});
      return restore({pass,target,vehicleId,cardId,useTestCredit});
    });
  }
  return {view,topup,reconcile,notification,issue};
}

export function finalBill(charge,attemptId,cdr){
  if(!uuid(attemptId) || !cdr || typeof cdr.id!=='string' || !/^[!-~]{1,39}$/.test(cdr.id) || cdr.credit || cdr.credit_reference_id ||
    cdr.authorization_reference!==attemptId || cdr.currency!=='ZAR' || !Number.isFinite(Date.parse(cdr.end_date_time))) reject(409,'INVALID_WALLET_CDR');
  const connector=cdr.cdr_location;
  const target={country_code:cdr.country_code,party_id:cdr.party_id,location_id:connector?.id,evse_uid:connector?.evse_uid,connector_id:connector?.connector_id};
    if(!charge || !sameWalletTarget(target,charge.target) || (charge.sessionId && cdr.session_id && charge.sessionId!==cdr.session_id))reject(409,'WALLET_CDR_MISMATCH');
    const ends=Date.parse(cdr.end_date_time),starts=Date.parse(cdr.start_date_time);
    if(!Number.isFinite(starts) || starts>ends || starts<Date.parse(charge.createdAt)-300000 || ends>Date.now()+300000)reject(409,'WALLET_CDR_MISMATCH');
    // This connector's verified all-day, energy-only tariff is frozen at start. If VAT is absent, accept the
    // exclusive amount only when it agrees to the cent with that driver's rate and the CPO's final meter.
    const energy=cdr.total_energy,price=cdr.total_cost,inclusive=price?.incl_vat,exclusive=price?.excl_vat;
    if(!Number.isFinite(energy) || energy<0 || typeof exclusive!=='number' || !Number.isFinite(exclusive) || exclusive<0 ||
      (inclusive!=null && (!Number.isFinite(inclusive) || inclusive<0)))reject(409,'WALLET_CDR_COST_UNVERIFIED');
    const cents=Math.round((inclusive??exclusive)*100+1e-8);
    if(!Number.isSafeInteger(cents) || cents!==Math.round(energy*Number(charge.tariff.total_per_kwh)*100+1e-8))reject(409,'WALLET_CDR_COST_UNVERIFIED');
    return {cents,energy};
}

export function notification(tx,user,id,kind,fields={}){
  tx.set(user.collection('notifications').doc(id+'-'+kind),{orderId:id,kind,...fields,createdAt:stamp()});
}
export async function notifyStarted(db,uid,id){
  const user=db.collection('users').doc(uid),entry=user.collection('notifications').doc(id+'-STARTED');
  await db.runTransaction(async tx=>{
    if(!(await tx.get(entry)).exists)notification(tx,user,id,'STARTED');
  });
}
export async function settleWallet(db,attemptId,cdr) {
  if(!uuid(attemptId))reject(409,'INVALID_WALLET_CDR');
  const ref=db.collection('afe_wallet_charges').doc(attemptId);
  return db.runTransaction(async tx=>{
    const charge=(await tx.get(ref)).data();
    const {cents,energy}=finalBill(charge,attemptId,cdr);
    if(charge.funding==='card' || charge.state==='REJECTED')reject(409,'WALLET_CDR_MISMATCH');
    if(charge.state==='SETTLED'){
      if(charge.cdrId!==cdr.id || charge.costCents!==cents || (charge.energyKwh!=null && charge.energyKwh!==energy))reject(409,'WALLET_CDR_MISMATCH');
      return;
    }
    const user=db.collection('users').doc(charge.uid),unique=db.collection('afe_wallet_cdrs').doc(hash(JSON.stringify([cdr.country_code,cdr.party_id,cdr.id])));
    if(charge.state==='CLOSED_UNCONFIRMED'){
      const claimed=(await tx.get(unique)).data();
      if(claimed || charge.reviewCdrId){
        if(claimed?.attemptId!==attemptId || charge.reviewCdrId!==cdr.id || charge.reviewCostCents!==cents || charge.reviewEnergyKwh!==energy)reject(409,'WALLET_CDR_MISMATCH');
      }else{
        tx.create(unique,{attemptId,disposition:'OPERATOR_REVIEW',costCents:cents,createdAt:stamp()});
        tx.update(ref,{reviewCdrId:cdr.id,reviewCostCents:cents,reviewEnergyKwh:energy,reviewReceivedAt:stamp(),nextCheckAt:FieldValue.delete()});
      }
      return 'OPERATOR_REVIEW';
    }
    const [account,claimed,started]=await tx.getAll(user,unique,user.collection('notifications').doc(attemptId+'-STARTED'));const driver=account.data();
    if(!driver || driver.walletCharge!==attemptId || claimed.exists) reject(409,'WALLET_CDR_MISMATCH');
    if(charge.creditReference && charge.creditReference!==pilotRef)reject(409,'STATION_CREDIT_REVIEW_REQUIRED');
    const pilot=charge.creditReference ? settlePilotCredit(tx,user,driver,charge,attemptId,cents,energy) : null;
    const shortfall=pilot ? 0 : Math.max(0,cents-Math.max(0,net(driver)));
    if(energy>0 && !started.exists)notification(tx,user,attemptId,'STARTED');
    notification(tx,user,attemptId,pilot?'TEST_CREDIT_SETTLED':'WALLET_SETTLED',{costCents:cents,shortfallCents:shortfall,...pilot});
    if(!pilot)post(tx,user,driver,{kind:'CHARGE',reference:attemptId,deltaCents:-cents,shortfallCents:shortfall,energyKwh:energy},'charge-'+attemptId);
    tx.create(unique,{attemptId,costCents:cents,...pilot,createdAt:stamp()});
    tx.update(user,{walletCharge:null,...(driver.activeCharge===attemptId && {activeCharge:null})});
    tx.update(ref,{state:'SETTLED',cdrId:cdr.id,costCents:cents,shortfallCents:shortfall,energyKwh:energy,...pilot,nextCheckAt:FieldValue.delete()});
    tx.update(user.collection('orders').doc(attemptId),{settlement:'SETTLED',costCents:cents,shortfallCents:shortfall,energyKwh:energy,...pilot});
  });
}
