'use strict';

function productionPayments({tr, esc, pair, render, getAccount}) {
  const passFormat = /^[A-Za-z0-9_-]{43}$/;
  const attemptFormat = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const referenceFormat = /^[a-f0-9]{16}$/;
  const moneyFormat = /^(?:0|[1-9]\d{0,9})\.\d{2}$/;
  const targetFields = ['country_code','party_id','location_id','evse_uid','connector_id'];
  const targetValid = t => targetFields.every(k => typeof t?.[k] === 'string' && t[k].trim() && t[k].length <= 36);
  const validAmount = n => typeof n === 'string' && moneyFormat.test(n) && Number(n) > 0;
  const key = 'afe.production.payment.v2.' + AFE_BASE_URL;
  let fundingChoice='card';
  let selectedCardId=null;
  let current = null, capability = null, receipt = null, busy = false, error = '', checkingAccess = false;
  let capabilityError = '', signedReturnIntent = null, returnEvidence = null;
  const commands=productionCommands({tr,esc,pair,render,password,getOrder:()=>current,getPayment:()=>receipt,targetValid});

  function save() {
    try {
      if (current) {
        const value=JSON.stringify(current);
        sessionStorage.setItem(key,value);
        return sessionStorage.getItem(key)===value;
      }
      else sessionStorage.removeItem(key);
      return true;
    } catch { return false; }
  }

  function validIntent(order) {
    const intent=order?.startIntent;
    return intent?.action==='start_after_pa' && attemptFormat.test(order.id) && intent.id===order.id &&
      referenceFormat.test(order.reference) && intent.reference===order.reference && validAmount(order.amount) &&
      intent.amount===order.amount && targetValid(order.target) && targetValid(intent.target) &&
      targetFields.every(k=>intent.target[k]===order.target[k]) &&
      Number.isSafeInteger(intent.created) && Date.now()>=intent.created && Date.now()-intent.created<=15*60*1000;
  }
  function restore() {
    const url = new URL(location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    let saved;
    try { saved=JSON.parse(sessionStorage.getItem(key)); } catch {}
    if (!AFEAuth.token() && !fragment.has('afe_payment_return')) return;
    if (fragment.has('afe_payment_return')) {
      const pass = fragment.get('afe_payment_return'), id = fragment.get('attempt');
      url.hash = '';
      history.replaceState(null, '', url.pathname + url.search);
      if (passFormat.test(pass) && attemptFormat.test(id)) {
        current = {pass,id};
        if (saved?.id===id && passFormat.test(saved.pass) && saved.pass!==pass && validIntent(saved)) {
          Object.assign(current,{amount:saved.amount,reference:saved.reference,target:saved.target});
          // Take the consent out of storage before any asynchronous work. Reloads,
          // back navigation and manual receipt lookups can only recover manually.
          if (save()) signedReturnIntent=saved;
        } else save();
      } else error = 'INVALID_PAYMENT_RETURN';
      return;
    }
    if (passFormat.test(saved?.pass) && (!saved.id || attemptFormat.test(saved.id)) &&
        (!saved.target || targetValid(saved.target)) && (!saved.amount || validAmount(saved.amount))) {
      current=saved; delete current.startIntent; save();
    }
  }
  restore();

  async function loadCapability() {
    if (!AFE_BASE_URL || checkingAccess) return;
    checkingAccess = true;
    try {
      const data = await AFEApi.paymentCapabilities();
      if (typeof data.enabled !== 'boolean' || (data.enabled && (!validAmount(data.amount) ||
          data.currency !== 'ZAR' || data.paymentType !== 'PA'))) throw new ChargeApiError(502,'INVALID_PAYMENT_CONFIGURATION');
      capability = data.enabled ? {amount:data.amount, currency:data.currency} : null;
      capabilityError = '';
    } catch (err) {
      capability = null;
      capabilityError = err instanceof ChargeApiError ? err.code : 'PAYMENT_SERVICE_UNREACHABLE';
    } finally { checkingAccess = false; render(); }
  }
  function errorCode(err) {
    return err instanceof ChargeApiError ? err.code : 'PAYMENT_SERVICE_UNREACHABLE';
  }
  function requireMatch(result) {
    if (!attemptFormat.test(result.attemptId) || typeof result.reference!=='string' || !referenceFormat.test(result.reference) ||
        !validAmount(result.amount) || result.currency !== 'ZAR' ||
        (current.id && result.attemptId !== current.id) ||
        (current.reference && result.reference !== current.reference) ||
        (current.amount && result.amount !== current.amount)) throw new ChargeApiError(502,'PAYMENT_ORDER_MISMATCH');
  }
  async function checkStatus() {
    if (!AFE_BASE_URL || !AFEAuth.token() || !current || busy) return;
    if(['wallet','card'].includes(current.funding)){await commands.query();return;}
    busy = true; error = ''; receipt = null; render();
    try {
      const result = await AFEApi.paymentStatus(current.pass);
      requireMatch(result);
      if (result.paymentType !== 'PA' || !targetValid(result.target) || !Number.isFinite(Date.parse(result.checkedAt)) ||
          !['AUTHORIZED','DECLINED','CANCELLED','PENDING','UNCONFIRMED'].includes(result.status) ||
          (current.target && targetFields.some(k => current.target[k] !== result.target[k]))) {
        throw new ChargeApiError(502,'PAYMENT_STATUS_UNVERIFIED');
      }
      Object.assign(current, {id:result.attemptId,reference:result.reference,amount:result.amount,target:result.target});
      save(); receipt = result;
    } catch (err) { error = errorCode(err); }
    finally { busy = false; render(); returnEvidence=await commands.query(); }
  }
  async function finishReturn(selectTarget) {
    const original=signedReturnIntent;
    signedReturnIntent=null;
    if (!original || !validIntent(original) || !returnEvidence || returnEvidence.canCommand!==false ||
        returnEvidence.attemptId!==original.id || returnEvidence.start || returnEvidence.session.state!=='NOT_STARTED' ||
        receipt?.status!=='AUTHORIZED' || receipt.attemptId!==original.id || receipt.reference!==original.reference ||
        !targetFields.every(k=>receipt.target[k]===original.target[k]) || receipt.amount!==original.amount ||
        current?.id!==original.id || document.hidden) return;
    const order=current;
    const verified=await commands.query(original.pass,(pass,value)=>{
      Object.assign(order,{pass,id:value.attemptId,target:value.target});
    });
    if (current!==order || !verified?.canCommand || !validIntent(original) || !save() || document.hidden) return;
    const gun=selectTarget(original.target);
    if (commands.mayStart(gun)) await commands.send('start-charge',gun);
  }
  function checkoutURL(raw) {
    let url;
    try { url = new URL(raw); } catch {}
    if (url?.origin !== 'https://secure.peachpayments.com' || url.username || url.password || url.hash) {
      throw new ChargeApiError(502,'UNEXPECTED_CHECKOUT_URL');
    }
    return url.href;
  }
  async function checkout(gun, vehicleId, confirmedAmount, saveCard, cardId) {
    if (current || busy || !capability || !commands.permitsCheckout(gun) || !gun || gun.standard !== 'IEC_62196_T2_COMBO' ||
        gun.status !== 'AVAILABLE' || !targetValid(gun)) return;
    if (capability.amount !== confirmedAmount) { error = 'PAYMENT_AMOUNT_CHANGED'; render(); return; }
    const target = Object.fromEntries(targetFields.map(k => [k,gun[k]]));
    const intentKey='afe.intent.'+AFE_BASE_URL;
    const choice=JSON.stringify([vehicleId,confirmedAmount,target,saveCard,cardId]);
    let intent;
    try { intent=JSON.parse(sessionStorage.getItem(intentKey)); } catch {}
    if (intent?.choice!==choice || !attemptFormat.test(intent?.id)) {
      intent={choice,id:crypto.randomUUID()};sessionStorage.setItem(intentKey,JSON.stringify(intent));
    }
    busy = true; error = ''; receipt = null; render();
    try {
      const grant=await AFEApi.account('/me/charge-intents','POST',{target,vehicleId,amount:confirmedAmount,saveCard,cardId,requestId:intent.id});
      if (!passFormat.test(grant.pass) || !attemptFormat.test(grant.attemptId)) throw new ChargeApiError(502,'PAYMENT_ORDER_MISMATCH');
      current={pass:grant.pass,id:grant.attemptId,amount:confirmedAmount,target};
      if(!save()){current=null;throw new ChargeApiError(0,'PAYMENT_SESSION_STORAGE_UNAVAILABLE');}
      sessionStorage.removeItem(intentKey);
      const result = await AFEApi.createCheckout(grant.pass, {target,amount:confirmedAmount,currency:'ZAR'});
      requireMatch(result);
      if (result.status !== 'CHECKOUT_CREATED') throw new ChargeApiError(502,'CHECKOUT_UNCONFIRMED');
      const url = checkoutURL(result.redirect_url);
      const startIntent={action:'start_after_pa',created:Date.now(),id:result.attemptId,reference:result.reference,amount:confirmedAmount,target};
      Object.assign(current,{id:result.attemptId,reference:result.reference,startIntent});
      if (!save()) throw new ChargeApiError(0,'PAYMENT_SESSION_STORAGE_UNAVAILABLE');
      location.assign(url);
    } catch (err) {
      error = errorCode(err);
    } finally { busy = false; render(); }
  }
  async function startFunded(gun,vehicleId,funding,cardId=null){
    const account=getAccount();
    if(busy || current || !vehicleId || (funding==='wallet'?!account.wallet()?.canFundCharge:!account.wallet()?.cardDirectEnabled || !account.savedCards().some(card=>card.direct && card.id===cardId)) || !commands.permitsCheckout(gun) || gun?.status!=='AVAILABLE' || gun.standard!=='IEC_62196_T2_COMBO' || gun.tariff?.status!=='verified')return;
    const target=Object.fromEntries(targetFields.map(k=>[k,gun[k]])),key='afe.intent.'+AFE_BASE_URL;
    const choice=JSON.stringify([funding,target,vehicleId,cardId]);
    let intent;try{intent=JSON.parse(sessionStorage.getItem(key));}catch{}
    if(intent?.choice!==choice || !attemptFormat.test(intent.id)){intent={choice,id:crypto.randomUUID()};sessionStorage.setItem(key,JSON.stringify(intent));}
    busy=true;error='';render();
    try{
      const grant=await AFEApi.account('/me/charge-intents','POST',{funding,cardId,target,vehicleId,requestId:intent.id});
      if(grant.funding!==funding || !passFormat.test(grant.pass) || !attemptFormat.test(grant.attemptId) ||
        !targetFields.every(k=>grant.target?.[k]===target[k]))throw new ChargeApiError(502,'WALLET_ORDER_MISMATCH');
      current={pass:grant.pass,id:grant.attemptId,target,funding};
      if(!save()){current=null;throw new ChargeApiError(0,'PAYMENT_SESSION_STORAGE_UNAVAILABLE');}
      sessionStorage.removeItem(key);
      const checked=await commands.query();
      if(checked?.canCommand && !document.hidden && commands.mayStart(gun))await commands.send('start-charge',gun);
    }catch(e){error=errorCode(e);}
    finally{busy=false;void account.loadWallet();render();}
  }
  function walletChoice(gun){
    const account=getAccount(),info=account.wallet();
    if(!gun)return '';
    let body='<p>'+tr('Top up if your balance is too low.','余额不足请充值。')+'</p>';
    if(!account.active())return body+'<button class="rec-refresh" data-page="wallet">'+tr('Sign in to view wallet','登录查看钱包')+'</button>';
    if(info)body+='<p>'+tr('Available','可用余额')+' R'+(info.balanceCents/100).toFixed(2)+' · '+tr('Start above','启动须大于')+' R'+(info.minimumCents/100).toFixed(2)+'</p>';
    if(info?.canFundCharge && commands.permitsCheckout(gun) && gun.standard==='IEC_62196_T2_COMBO' && gun.status==='AVAILABLE' && gun.tariff?.status==='verified'){
      body+='<p>'+tr('AFE requests a stop as your balance runs low. The final charging bill is deducted from your wallet.','余额接近用尽时，AFE 会向桩请求停充，最终按实际账单扣费。')+'</p><form class="rec-picker" data-form="wallet-start">'+
        account.chargeControls(true)+(account.hasVehicles()?submit(tr('Start with wallet','用钱包启动充电')):'')+'</form>';
    }
    return body+'<button class="rec-refresh" type="button" data-page="wallet">'+tr('Open wallet','查看钱包')+'</button>';
  }
  function directChoice(gun){
    const account=getAccount(),list=account.savedCards();
    let body='<p>'+tr('Your linked card is charged automatically after charging.','充电结束后自动扣款。')+'</p>';
    let startForm='';
    if(!account.active())return body+'<button type="button" class="rec-refresh" data-account="station-login">'+tr('Sign in to choose or link a card','登录后选择或绑定银行卡')+'</button>';
    if(list.length){
      const eligible=list.filter(c=>c.direct);
      const chosen=selectedCardId ?? (eligible.length===1 ? eligible[0].id : '');
      const options=list.map(c=>'<option value="'+esc(c.id)+'"'+(c.direct?(c.id===chosen?' selected':''):' disabled')+'>'+
        esc(c.brand)+' ···· '+esc(c.last4)+(c.direct?'':tr(' · Link again to authorise',' · 需重新绑定授权'))+'</option>').join('');
      const canStart=eligible.length>0 && account.wallet()?.cardDirectEnabled && commands.permitsCheckout(gun) &&
        gun?.status==='AVAILABLE' && gun.standard==='IEC_62196_T2_COMBO' && gun.tariff?.status==='verified';
      body+='<label class="acct-field">'+tr('Pay with','本次付款银行卡')+
        '<select class="app-select" form="charge-by-card" name="cardId" data-charge-card required><option value="" disabled'+
        (eligible.some(c=>c.id===chosen)?'':' selected')+'>'+tr('Choose a bank card','请选择银行卡')+'</option>'+options+'</select></label>';
      if(canStart)startForm='<form class="rec-picker" id="charge-by-card" data-form="card-start">'+
        account.chargeControls(true)+(account.hasVehicles()?submit(tr('Start charging','启动充电')):'')+'</form>';
    }
    const label=list.length?tr('Link another card','绑定新银行卡'):tr('Link a bank card','绑定银行卡');
    const pending=account.wallet()?.cardDirectEnabled===false ? ' · '+tr('Awaiting activation','待开通') : '';
    return body+'<details class="station-card-link"><summary>'+label+pending+'</summary>'+account.cardBinding()+'</details>'+startForm;
  }
  function chooseCard(id){
    if(getAccount().savedCards().some(card=>card.direct && card.id===id))selectedCardId=id;
  }
  function fundingPicker(gun){
    if(!gun)return '';
    return '<div class="funding-options" role="group" aria-label="'+tr('Payment method','支付方式')+'">'+
      [['card',tr('Bank card','银行卡')],['wallet',tr('Wallet','钱包')]].map(([id,label])=>
        '<button type="button" class="rec-refresh" data-act="fund-'+id+'" aria-pressed="'+(id===fundingChoice)+'">'+label+'</button>').join('')+'</div>'+
      (fundingChoice==='wallet'?walletChoice(gun):directChoice(gun));
  }
  function password(id) {
    return '<label for="'+id+'">'+tr('Operator pass','操作通行证')+'</label>'+
      '<input class="app-input" id="'+id+'" type="password" autocomplete="off" autocapitalize="none" '+
      'spellcheck="false" minlength="43" maxlength="43" required pattern="[A-Za-z0-9_\\-]{43}">';
  }
  function submit(label) {
    return '<button class="rec-refresh" type="submit"'+(busy?' disabled':'')+'>'+label+'</button>';
  }
  function statusText(status) {
    const labels = {
      AUTHORIZED:tr('Preauthorisation confirmed','预授权已确认'), PENDING:tr('Preauthorisation pending','预授权处理中'),
      DECLINED:tr('Preauthorisation declined','预授权被拒绝'), CANCELLED:tr('Payment cancelled','支付已取消'),
      UNCONFIRMED:tr('Preauthorisation unconfirmed','预授权尚未确认')
    };
    return labels[status];
  }
  function card(gun, stationView=false) {
    let content = '';
    if(['wallet','card'].includes(current?.funding)){
      content='<p>'+(current.funding==='card'?tr('Your card will be charged for the final bill.','充电结束后按最终账单自动扣款。'):tr('This session uses your AFE wallet. The final bill and any outstanding amount appear in Orders and Wallet.','本次使用 AFE 钱包。最终账单及待补金额可在订单和钱包中查看。'))+'</p>'+
        '<button class="rec-refresh" type="button" data-act="close-payment"'+(busy||commands.isBusy()?' disabled':'')+'>'+tr('Close order view','关闭订单视图')+'</button>';
    }else if (current) {
      content = '<p role="status">'+(busy ? tr('Checking with Peach…','正在联系 Peach…') : receipt ? statusText(receipt.status) :
        tr('The preauthorisation has not been verified.','预授权结果待核验。'))+'</p>';
      const t = receipt?.target || current.target;
      content += '<dl class="rec-details">'+pair(tr('Amount','金额'), current.amount && 'ZAR '+current.amount)+
        (stationView ? '' : pair(tr('Payment reference','支付参考号'),current.reference)+pair(tr('Connector','枪口'),t && [t.location_id,t.evse_uid,t.connector_id].join(' / '))+
        pair(tr('Checked at (UTC)','核验时间（UTC）'),receipt?.checkedAt))+'</dl>'+
        '<button class="rec-refresh" type="button" data-act="payment-status"'+(busy || !AFE_BASE_URL?' disabled':'')+'>'+
        tr('Check payment status','查询预授权结果')+'</button>'+
        '<button class="rec-refresh" type="button" data-act="close-payment"'+(busy||commands.isBusy()?' disabled':'')+'>'+
        tr('Close payment view','关闭本次支付视图')+'</button>';
    } else {content=fundingPicker(gun);}
    if (error) content += '<p role="alert" class="rec-alert">'+tr('Check the payment or charging status','请核对付款或充电状态')+' · '+esc(error)+'</p>';
    if (!current && getAccount().active()) content+='<button class="rec-refresh" type="button" data-page="orders">'+tr('My orders','我的订单')+'</button>';
    return '<section class="app-card rec-card"><h2>'+(current?.funding==='wallet'?tr('Wallet charging','钱包充电'):tr('Pay for charging','充电支付'))+'</h2>'+content+commands.card(gun,stationView)+'</section>';
  }
  function submitForm(event, gun) {
    const form = event.target;
    if (!form.matches('form[data-form]')) return;
    event.preventDefault();
    if(['wallet-start','card-start'].includes(form.dataset.form)){
      const values=new FormData(form);void startFunded(gun,values.get('vehicleId'),form.dataset.form==='card-start'?'card':'wallet',values.get('cardId'));return;
    }
    if(form.dataset.form==='checkout'){
      if(!busy && getAccount().hasVehicles()){
        const v=new FormData(form);void checkout(gun,v.get('vehicleId'),form.dataset.amount,!!v.get('saveCard') && !v.get('cardId'),v.get('cardId') || null);
      }
      return;
    }
    const pass = form.querySelector('input')?.value.trim();
    if (!passFormat.test(pass) || busy) return;
    if (form.dataset.form==='unlock-commands' && current) {
      void commands.query(pass,(original,result) => {
        Object.assign(current,{pass:original,id:result.attemptId,target:result.target}); save();
      });
      return;
    }
    if (current) return;

    if (form.dataset.form === 'lookup') { current = {pass}; save(); void checkStatus(); }
  }
  function action(name,gun) {
    if(name==='fund-card' || name==='fund-wallet'){fundingChoice=name.slice(5);render();return;}
    if (name === 'payment-status') void checkStatus();
    if (name === 'session-status') void commands.query();
    if (name === 'start-charge' || name === 'stop-charge') void commands.send(name,gun);
    if (name === 'close-payment' && !busy && !commands.isBusy()) { commands.clear(); current = null; receipt = null; error = ''; save(); render(); }
  }
  window.addEventListener('pageshow', event => { if (event.persisted && current) void checkStatus(); });
  async function resume(grant){
    if(busy || commands.isBusy())return;
    if(!passFormat.test(grant.pass) || !attemptFormat.test(grant.attemptId) || !targetValid(grant.target))throw new ChargeApiError(502,'PAYMENT_ORDER_MISMATCH');
    commands.clear();receipt=null;current={pass:grant.pass,id:grant.attemptId,target:grant.target,amount:grant.amount,...(['card','wallet'].includes(grant.funding) && {funding:grant.funding})};
    save();await checkStatus();
  }
  return {card,resume,submitForm,action,chooseCard,loadCapability,loadCommands:commands.load,checkStatus,finishReturn,
    hasOrder:() => current !== null, target:() => current?.target};
}
