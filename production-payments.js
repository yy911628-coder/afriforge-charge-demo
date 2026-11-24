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
  function card(gun) {
    let content = '';
    if (current) {
      content = '<p role="status">'+(busy ? tr('Checking with Peach…','正在联系 Peach…') : receipt ? statusText(receipt.status) :
        tr('The preauthorisation has not been verified.','预授权结果待核验。'))+'</p>';
      const t = receipt?.target || current.target;
      content += '<dl class="rec-details">'+pair(tr('Amount','金额'), current.amount && 'ZAR '+current.amount)+
        pair(tr('Payment reference','支付参考号'),current.reference)+pair(tr('Connector','枪口'),t && [t.location_id,t.evse_uid,t.connector_id].join(' / '))+
        pair(tr('Checked at (UTC)','核验时间（UTC）'),receipt?.checkedAt)+'</dl>'+
        '<button class="rec-refresh" type="button" data-act="payment-status"'+(busy || !AFE_BASE_URL?' disabled':'')+'>'+
        tr('Check payment status','查询预授权结果')+'</button>'+
        '<button class="rec-refresh" type="button" data-act="close-payment"'+(busy||commands.isBusy()?' disabled':'')+'>'+
        tr('Close payment view','关闭本次支付视图')+'</button>';
    } else if (capability && commands.permitsCheckout(gun) && gun?.standard === 'IEC_62196_T2_COMBO' && gun.status === 'AVAILABLE') {
      content='<p>'+tr('Peach will request a card hold. When the hold is confirmed, AFE will start the selected connector.','Peach 将申请银行卡预授权。预授权确认后，AFE 将启动所选枪口。')+'</p>'+
        '<form class="rec-picker" data-form="checkout" data-amount="'+esc(capability.amount)+'">'+getAccount().chargeControls()+
        (getAccount().hasVehicles()?submit(tr('Preauthorise ZAR ','预授权 ZAR ')+esc(capability.amount)+tr(' and start charging',' 并启动充电')):'')+'</form>';
    } else {
      content='<p>'+(!AFE_BASE_URL || (!capability && !capabilityError) ?
        tr('Production card payments are not enabled.','正式银行卡支付尚未开通。') :
        capabilityError ? tr('Payment service unavailable','暂时无法读取支付配置')+' · '+esc(capabilityError) :
        tr('Preauthorisation requires an available CCS2 connector enabled for remote start.','请选择已开通远程启动且当前可用的 CCS2 枪口进行预授权。'))+'</p>';
    }
    if (error) content += '<p role="alert" class="rec-alert">'+tr('Payment could not be verified','支付结果尚未核验')+' · '+esc(error)+'</p>';
    if (!current && getAccount().active()) content+='<button class="rec-refresh" type="button" data-page="orders">'+tr('My orders','我的订单')+'</button>';
    return '<section class="app-card rec-card"><h2>'+tr('Card preauthorisation','银行卡预授权')+'</h2>'+content+commands.card(gun)+'</section>';
  }
  function submitForm(event, gun) {
    const form = event.target;
    if (!form.matches('form[data-form]')) return;
    event.preventDefault();
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
    if (name === 'payment-status') void checkStatus();
    if (name === 'session-status') void commands.query();
    if (name === 'start-charge' || name === 'stop-charge') void commands.send(name,gun);
    if (name === 'close-payment' && !busy && !commands.isBusy()) { commands.clear(); current = null; receipt = null; error = ''; save(); render(); }
  }
  window.addEventListener('pageshow', event => { if (event.persisted && current) void checkStatus(); });
  async function resume(grant){
    if(busy || commands.isBusy())return;
    if(!passFormat.test(grant.pass) || !attemptFormat.test(grant.attemptId) || !targetValid(grant.target))throw new ChargeApiError(502,'PAYMENT_ORDER_MISMATCH');
    commands.clear();receipt=null;current={pass:grant.pass,id:grant.attemptId,target:grant.target,amount:grant.amount};
    save();await checkStatus();
  }
  return {card,resume,submitForm,action,loadCapability,loadCommands:commands.load,checkStatus,finishReturn,
    hasOrder:() => current !== null, target:() => current?.target};
}
