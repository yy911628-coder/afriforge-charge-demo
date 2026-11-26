'use strict';

function productionPayments({tr, esc, pair, render, getAccount, getGun, onStation, sessionLocation}) {
  const passFormat = /^[A-Za-z0-9_-]{43}$/;
  const attemptFormat = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const referenceFormat = /^[a-f0-9]{16}$/;
  const moneyFormat = /^(?:0|[1-9]\d{0,9})\.\d{2}$/;
  const targetFields = ['country_code','party_id','location_id','evse_uid','connector_id'];
  const targetValid = t => targetFields.every(k => typeof t?.[k] === 'string' && t[k].trim() && t[k].length <= 36);
  const validAmount = n => typeof n === 'string' && moneyFormat.test(n) && Number(n) > 0;
  const key = 'afe.production.payment.v2.' + AFE_BASE_URL;
  let fundingChoice='', selectedCardId=null, selectedVehicle='', starting=false, linking=false;
  let testCreditChoice='';
  const preview=stationExperience({tr,esc,render,getAccount,onLinked:id=>{fundingChoice='card';selectedCardId=id;}});
  let current = null, capability = null, receipt = null, busy = false, error = '', checkingAccess = false;
  let capabilityError = '', signedReturnIntent = null, returnEvidence = null;
  const commands=productionCommands({tr,esc,pair,render,password,getOrder:()=>current,getPayment:()=>receipt,targetValid,pilotRequest,sessionLocation});

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
        !preview.usable(gun) || gun.vehicle_connection!=='CONNECTED' || !targetValid(gun)) return;
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
  function eligibleCredit(gun){
    const credit=getAccount().wallet()?.testCredit;
    if(!credit || !gun || !['country_code','party_id','location_id'].every(k=>credit.scope?.[k]===gun[k]) ||
       !credit.evseUids?.includes(gun.evse_uid) || gun.connector_id!==gun.evse_uid+'01')return null;
    return credit;
  }
  function usingCredit(gun){
    return !!testCreditChoice && testCreditChoice===getAccount().owner() && !!eligibleCredit(gun);
  }
  function walletReady(gun){
    return usingCredit(gun)?eligibleCredit(gun).canFundCharge===true:getAccount().wallet()?.canFundCharge===true;
  }
  function pilotRequest(gun){
    if(!gun || preview.preview() || gun.standard!=='IEC_62196_T2_COMBO' ||
       !['AVAILABLE','RESERVED'].includes(gun.status) || gun.vehicle_connection==='DISCONNECTED')return false;
    if(current)return current.useTestCredit===true && current.funding==='wallet' && targetFields.every(k=>current.target?.[k]===gun[k]);
    return fundingChoice==='wallet' && usingCredit(gun) && walletReady(gun);
  }
  async function startFunded(gun,vehicleId,funding,cardId=null){
    const account=getAccount();
    if(busy || current || !vehicleId || preview.preview() || (funding==='wallet'?!walletReady(gun):!account.wallet()?.cardDirectEnabled || !account.savedCards().some(card=>card.direct && card.id===cardId)) || !commands.permitsCheckout(gun) ||
       !(pilotRequest(gun) || (preview.usable(gun) && preview.connected(gun))) || gun.tariff?.status!=='verified')return;
    const target=Object.fromEntries(targetFields.map(k=>[k,gun[k]])),key='afe.intent.'+AFE_BASE_URL;
    const useTestCredit=funding==='wallet' && usingCredit(gun);
    const choice=JSON.stringify([funding,target,vehicleId,cardId,useTestCredit]);
    let intent;try{intent=JSON.parse(sessionStorage.getItem(key));}catch{}
    if(intent?.choice!==choice || !attemptFormat.test(intent.id)){intent={choice,id:crypto.randomUUID()};sessionStorage.setItem(key,JSON.stringify(intent));}
    busy=true;error='';render();
    try{
      const grant=await AFEApi.account('/me/charge-intents','POST',{funding,cardId,target,vehicleId,requestId:intent.id,...(useTestCredit && {useTestCredit:true})});
      if(grant.funding!==funding || !!grant.useTestCredit!==useTestCredit || !passFormat.test(grant.pass) || !attemptFormat.test(grant.attemptId) ||
        !targetFields.every(k=>grant.target?.[k]===target[k]))throw new ChargeApiError(502,'WALLET_ORDER_MISMATCH');
      current={pass:grant.pass,id:grant.attemptId,target,funding,useTestCredit};
      if(!save()){current=null;throw new ChargeApiError(0,'PAYMENT_SESSION_STORAGE_UNAVAILABLE');}
      sessionStorage.removeItem(key);
      const checked=await commands.query();
      const liveGun=getGun();
      if(checked?.canCommand && onStation() && !document.hidden && commands.mayStart(liveGun))await commands.send('start-charge',liveGun);
    }catch(e){error=errorCode(e);}
    finally{busy=false;void account.loadWallet();render();}
  }
  function vehicle(){
    const list=getAccount().vehicles();
    return (list.find(v=>v.id===selectedVehicle) || list.find(v=>v.isDefault) || list[0])?.id || '';
  }
  function realCard(){
    const choices=getAccount().savedCards().filter(c=>c.direct);
    return choices.find(c=>c.id===selectedCardId) || (!selectedCardId && choices.length===1 ? choices[0] : null);
  }
  function demoCard(){return preview.cards().find(c=>c.id===selectedCardId);}
  function chooseCard(id){
    const sample=preview.cards().find(c=>c.id===id);
    if(sample){preview.enable();selectedCardId=sample.id;}
    else if(getAccount().savedCards().some(c=>c.direct && c.id===id)){preview.leave();selectedCardId=id;}
    render();
  }
  async function bindCard(){
    if(linking || starting || current || preview.session())return;
    const account=getAccount(),target=getGun(),owner=account.owner();
    linking=true;
    try{
      if(account.active() && !account.wallet() && !preview.preview())await account.loadWallet();
      if(!onStation() || owner!==account.owner() || fundingChoice!=='card' ||
         targetFields.some(k=>target?.[k]!==getGun()?.[k]))return;
      preview.showBinding(preview.preview() || !account.wallet()?.cardDirectEnabled);
    }finally{linking=false;}
  }
  function fundingPicker(gun){
    const account=getAccount(),info=account.wallet(),isDemo=preview.preview();
    const picker='<div class="funding-options" role="group" aria-label="'+tr('Payment method','支付方式')+'">'+
      [['card',tr('Bank card','银行卡')],['wallet',tr('Wallet','钱包')]].map(([id,label])=>
        '<button type="button" class="rec-refresh" data-act="fund-'+id+'" aria-pressed="'+(id===fundingChoice)+'"'+(preview.session()?' disabled':'')+'>'+label+'</button>').join('')+'</div>';
    if(!fundingChoice)return picker;
    let body='';
    if(fundingChoice==='wallet'){
      const credit=eligibleCredit(gun);
      const onCredit=usingCredit(gun);
      if(info){
        const cents=onCredit?credit.remainingCents:info.balanceCents;
        body='<p>'+tr(onCredit?'Available station test credit':'Wallet balance',onCredit?'本次可用试充额度':'钱包余额')+
          ' R'+(cents/100).toFixed(2)+' · '+tr('Start above','启动须大于')+' R'+(info.minimumCents/100).toFixed(2)+'</p>';
        if(!onCredit && cents<=info.minimumCents)body+='<p>'+(
          credit?.canFundCharge ? tr('Select station credit below, or top up your wallet.','可勾选下方本站试充额度，或为钱包充值。') :
          tr('Top up to start with your wallet.','钱包余额不足，请充值后启动。'))+'</p>';
        if(onCredit && cents<=info.minimumCents)body+='<p>'+tr('Station credit is too low to start.','本站试充额度不足以启动。')+'</p>';
      }
      if(credit)body+='<label class="acct-check"><input type="checkbox" data-station-credit'+(usingCredit(gun)?' checked':'')+'> '+
        tr('Internal test · use station credit','内部实车测试 · 使用本站试充额度')+' R'+(credit.remainingCents/100).toFixed(2)+'</label>';
      body+='<button type="button" class="text-action" '+(account.active()?'data-page="wallet"':'data-account="station-login"')+'>'+tr(account.active()?'Open wallet':'Sign in to use wallet',account.active()?'查看钱包':'登录使用钱包')+'</button>';
    }else{
      body='<p>'+tr('Your card is charged automatically after charging.','充电结束后自动扣款。')+'</p>';
      const cards=[...account.savedCards(),...preview.cards()];
      const chosen=isDemo?demoCard():realCard();
      if(cards.length)body+='<label class="acct-field">'+tr('Pay with','本次付款银行卡')+
        '<select class="app-select" data-charge-card'+(preview.session()?' disabled':'')+'><option value="" disabled'+(!chosen?' selected':'')+'>'+tr('Choose a card','请选择银行卡')+'</option>'+
        cards.map(c=>'<option value="'+esc(c.id)+'"'+(c.id===chosen?.id?' selected':'')+(!c.direct && !preview.cards().includes(c)?' disabled':'')+'>'+
          esc(c.brand)+' ···· '+esc(c.last4)+'</option>').join('')+'</select></label>';
      if(!preview.session())body+='<button type="button" class="text-action" data-act="bind-station-card">+ '+tr('Add a new card','添加新卡')+'</button>';
      if(!account.active() && !isDemo)body+='<button type="button" class="text-action" data-account="station-login">'+tr('Sign in for live payments','登录使用正式支付')+'</button>';
    }
    if(isDemo){
      body+='<p class="preview-note">'+tr('Demo card · Practice only','体验卡 · 模拟启动')+'</p>';
      if(!preview.session())body+='<button type="button" class="text-action" data-act="leave-preview">'+tr('Return to live charging','返回正式充电')+'</button>';
    }else if(account.active()){
      const vehicles=account.vehicles(),id=vehicle();
      body+=vehicles.length?'<label class="acct-field">'+tr('Charging vehicle','本次充电车辆')+'<select class="app-select" data-station-vehicle>'+
        vehicles.map(v=>'<option value="'+esc(v.id)+'"'+(v.id===id?' selected':'')+'>'+esc(v.nickname+' · '+v.plate)+'</option>').join('')+'</select></label>':
        '<button type="button" data-page="vehicle-new" class="text-action">'+tr('Add a vehicle','添加充电车辆')+'</button>';
    }
    return picker+body;
  }
  function fundingReady(gun){
    if(busy || starting || commands.isBusy() || !(preview.usable(gun) || pilotRequest(gun)))return false;
    if(!fundingChoice)return false;
    if(preview.preview())return !preview.session() && fundingChoice==='card' && !!demoCard();
    if(!vehicle() || !commands.permitsCheckout(gun) || gun.tariff?.status!=='verified')return false;
    const info=getAccount().wallet();
    return fundingChoice==='wallet'?walletReady(gun):info?.cardDirectEnabled===true && !!realCard();
  }
  function readyToStart(gun){
    if(!preview.connected(gun) && !pilotRequest(gun))return false;
    if(current)return !busy && !starting && !commands.isBusy() && !preview.preview() && !!commands.mayStart(gun);
    return fundingReady(gun);
  }
  function footer(gun,recheck=false){
    if(current && commands.hasStart())return '';
    if(preview.session()==='active')return '<span class="dock-hint" role="status">'+tr('Demo charging started','模拟充电已开始')+'</span><button type="button" class="station-primary" data-act="end-preview">'+tr('End demo','结束体验')+'</button>';
    let hint='';
    if(!gun)hint=tr('Select a connector','请选择充电枪');
    else if(pilotRequest(gun))hint=tr('With the selected cable plugged in, tap start for the station to verify it.','请插好所选枪口，再点开始充电。桩端会核验本次请求。');
    else if(gun.status==='RESERVED')hint=tr('Start unavailable while the reservation is unverified','预约归属待确认，暂不能启动');
    else if(gun.status==='CHARGING')hint=tr('This connector has a session in progress','此枪正在充电');
    else if(!preview.usable(gun))hint=tr('This connector is unavailable','此枪当前不可启动');
    else if(!preview.connected(gun) && !recheck)hint=gun.vehicle_connection==='UNKNOWN' && !preview.preview() ?
      tr('Awaiting plug confirmation from the station','等待桩端确认连接') : tr('Connect the cable to your vehicle','请先将充电枪插入车辆');
    else if(!current && !fundingChoice)hint=tr('Choose a payment method','请选择支付方式');
    else if(!current && !preview.preview() && fundingChoice==='wallet' && !walletReady(gun))hint=tr('Choose sufficient wallet funds','请选择足额的可用余额或试充额度');
    else if(!current && fundingChoice==='card' && !(preview.preview()?demoCard():realCard()))hint=tr('Link or choose a card','请绑定或选择银行卡');
    const checkFirst=recheck && !current && !preview.preview() && !preview.connected(gun) && !pilotRequest(gun);
    if(checkFirst && fundingReady(gun))hint=tr('Checks the plug with the station before starting','启动前将向桩端复核连接');
    const problem=commands.failureText(error) || commands.lastProblem();
    return (problem?'<span class="dock-hint charge-warning" role="alert">'+problem+'</span>':hint?'<span class="dock-hint">'+hint+'</span>':'')+'<button class="station-primary" type="button" data-act="'+(checkFirst?'verify-then-start':'station-start')+'"'+((checkFirst?fundingReady(gun):readyToStart(gun))?'':' disabled')+'>'+
      (preview.preview()?tr('Start demo charging','开始充电（模拟）'):tr('Start charging','开始充电'))+'</button>';
  }
  async function stationStart(gun){
    if(!onStation() || !readyToStart(gun))return;
    if(preview.preview()){preview.startDemo(gun);return;}
    starting=true;render();
    try{
      if(current)await commands.send('start-charge',gun);
      else await startFunded(gun,vehicle(),fundingChoice,fundingChoice==='card'?realCard()?.id:null);
    }finally{starting=false;render();}
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
    if(!stationView && commands.hasStart())return commands.screen()+commands.sessionFooter();
    let content = '';
    if(['wallet','card'].includes(current?.funding)){
      const source=current.useTestCredit?tr('This internal session uses the station test credit.','本次内部试充使用本站运营额度。'):
        current.funding==='card'?tr('Your card will be charged for the final bill.','充电结束后按最终账单自动扣款。'):tr('This session uses your AFE wallet. The final bill and any outstanding amount appear in Orders and Wallet.','本次使用 AFE 钱包。最终账单及待补金额可在订单和钱包中查看。');
      content='<p>'+source+'</p>'+
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
    if (error) content += '<p role="alert" class="rec-alert">'+(commands.failureText(error) || esc(error))+'</p>';
    if (!current && getAccount().active()) content+='<button class="rec-refresh" type="button" data-page="orders">'+tr('My orders','我的订单')+'</button>';
    return '<section class="app-card rec-card"><h2>'+(current?.funding==='wallet'?tr('Wallet charging','钱包充电'):tr('Pay for charging','充电支付'))+'</h2>'+content+
      (current || !stationView ? commands.card(gun,stationView) : '')+'</section>';
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
    if(name==='fund-card' || name==='fund-wallet'){
      if(preview.session() || current || starting)return;
      fundingChoice=name.slice(5);
      if(fundingChoice==='wallet')preview.leave();
      render();
      if(fundingChoice==='card' && !getAccount().savedCards().some(c=>c.direct) && !preview.cards().length)void bindCard();
      return;
    }
    if(name==='bind-station-card'){void bindCard();return;}
    if(name==='toggle-plug'){preview.toggle(gun);render();return;}
    if(name==='leave-preview'){preview.leave();selectedCardId=null;render();return;}
    if(name==='end-preview'){preview.finish();render();return;}
    if(name==='station-start'){void stationStart(gun);return;}
    if (name === 'payment-status') void checkStatus();
    if (name === 'session-status') void commands.query();
    if (name === 'start-charge' || name === 'stop-charge') void commands.send(name,gun);
    if (name === 'close-payment' && !busy && !commands.isBusy()) { commands.clear(); current = null; receipt = null; error = ''; save(); render(); }
  }
  window.addEventListener('pageshow', event => { if (event.persisted && current) void checkStatus(); });
  async function resume(grant){
    if(busy || commands.isBusy())return;
    if(!passFormat.test(grant.pass) || !attemptFormat.test(grant.attemptId) || !targetValid(grant.target))throw new ChargeApiError(502,'PAYMENT_ORDER_MISMATCH');
    commands.clear();receipt=null;current={pass:grant.pass,id:grant.attemptId,target:grant.target,amount:grant.amount,...(['card','wallet'].includes(grant.funding) && {funding:grant.funding,useTestCredit:grant.useTestCredit===true})};
    save();await checkStatus();
  }
  return {card,resume,submitForm,action,chooseCard,loadCapability,loadCommands:commands.load,checkStatus,finishReturn,
    selectCredit(checked,gun){testCreditChoice=checked && eligibleCredit(gun)?getAccount().owner():'';error='';render();},
    resetCredit(){testCreditChoice='';},
    fundingReady,selectionKey:()=>JSON.stringify([getAccount().owner(),vehicle(),fundingChoice,selectedCardId,testCreditChoice,current?.id]),
    pilotRequest,footer,preview,vehicle,sessionScreen:commands.screen,sessionFooter:commands.sessionFooter,hasDispatch:commands.hasStart,
    chooseVehicle(id){selectedVehicle=id;render();},
    linked(id,vehicleId){fundingChoice='card';selectedCardId=id || null;selectedVehicle=vehicleId || '';},
    isStarting:()=>starting || preview.session()==='starting',
    hasOrder:() => current !== null, target:() => current?.target};
}
