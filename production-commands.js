'use strict';

function productionCommands({tr, esc, pair, render, password, getOrder, getPayment, targetValid}) {
  const fields = ['country_code','party_id','location_id','evse_uid','connector_id'];
  const same = (a,b) => targetValid(a) && targetValid(b) && fields.every(key => a[key]===b[key]);
  const isoTime = input => typeof input==='string' && Number.isFinite(Date.parse(input));
  const flag = input => input == null || (typeof input==='string' && /^[A-Z0-9_]{1,48}$/.test(input));
  const when = input => isoTime(input) ? new Date(input).toISOString() : '';
  const sessionStates = ['NOT_STARTED','NOT_CHECKED','MATCHED','NOT_FOUND','AMBIGUOUS','INVALID_RECORD','LOOKUP_UNAVAILABLE'];
  const ocpiStates = ['PENDING','ACTIVE','COMPLETED','INVALID','RESERVATION'];
  let capability = null, data = null, busy = false, checkingAccess = false;
  let error = '', poll, uncertain = false, stopUnconfirmed = false;
  function clear() {
    clearTimeout(poll);
    data = null; error = ''; uncertain = false; stopUnconfirmed = false;
  }
  function safeResult(value,order) {
    if (typeof value.canCommand!=='boolean' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.attemptId) ||
        !targetValid(value.target) || (order.id && order.id!==value.attemptId) || (order.target && !same(order.target,value.target)) ||
        !sessionStates.includes(value.session?.state)) return false;
    const s=value.session;
    if (s.state==='MATCHED' && (typeof s.id!=='string' || !s.id.trim() || !ocpiStates.includes(s.status))) return false;
    if (s.kwh!=null && (typeof s.kwh!=='number' || !Number.isFinite(s.kwh) || s.kwh<0)) return false;
    return [value.start,value.stop].every(command => command===null ||
      (command && isoTime(command.requestedAt) && flag(command.ack) && flag(command.callback) &&
        (command.acknowledgedAt==null || isoTime(command.acknowledgedAt)) &&
        (command.callbackAt==null || isoTime(command.callbackAt))));
  }
  function active() { return data?.session.state==='MATCHED' && data.session.status==='ACTIVE'; }
  function finished() { return data?.session.state==='MATCHED' && ['COMPLETED','INVALID'].includes(data.session.status); }
  function mayStart(gun) {
    const p=getPayment();
    return data?.canCommand && !uncertain && !data.start && data.session.state==='NOT_STARTED' &&
      permitsCheckout(data.target) && ((['wallet','card'].includes(getOrder()?.funding) && data.funding===getOrder().funding) ||
      (p?.status==='AUTHORIZED' && p.attemptId===data.attemptId && same(p.target,data.target))) &&
      same(gun,data.target) && gun.standard==='IEC_62196_T2_COMBO' && gun.status==='AVAILABLE';
  }
  function pollSoon() {
    clearTimeout(poll);
    const waitingForBill=['wallet','card'].includes(data?.funding) && !['SETTLED','REJECTED','PAYMENT_REQUIRED'].includes(data.wallet?.settlement);
    if (data?.start && (!finished() || waitingForBill) && !['REJECTED','NOT_SUPPORTED'].includes(data.start.ack) &&
        !['REJECTED','FAILED'].includes(data.start.callback) && !document.hidden) {
      poll=setTimeout(() => {
        if (document.hidden) return;
        if (document.activeElement?.matches('input,select')) {pollSoon();return;}
        void query();
      },finished()?30000:12000);
    }
  }
  async function load() {
    if (!AFE_BASE_URL || checkingAccess) return;
    checkingAccess=true;
    try {
      const value=await AFEApi.commandCapabilities();
      const targets=value.targets===undefined && targetValid(value.target) ? [value.target] : value.targets;
      capability=Array.isArray(targets) && targets.every(targetValid)
        ? {enabled:value.enabled===true,targets,reason:value.reason} : {enabled:false,targets:[]};
    } catch { capability=null; }
    finally {checkingAccess=false;render();}
  }
  async function query(replacement, storeOriginal) {
    const order=getOrder();
    if (!order || busy || !AFE_BASE_URL) return;
    clearTimeout(poll);
    const pass=replacement || order.pass;
    busy=true; error=''; render();
    try {
      const value=await AFEApi.sessionStatus(pass);
      if (getOrder()!==order) return;
      if (!safeResult(value,order) || (data && (value.attemptId!==data.attemptId || !same(value.target,data.target)))) {
        throw new ChargeApiError(502,'SESSION_ORDER_MISMATCH');
      }
      if (replacement) {
        if (!value.canCommand) throw new ChargeApiError(403,'ORIGINAL_OPERATOR_PASS_REQUIRED');
        storeOriginal(pass,value);
      }
      data=value; uncertain=false; pollSoon();window.dispatchEvent(new Event('afe-charge-update'));
      return value;
    } catch(e) {
      if (getOrder()===order) { error=e instanceof ChargeApiError?e.code:'SESSION_STATUS_UNAVAILABLE'; uncertain=true; }
    } finally {busy=false;render();}
  }
  async function send(name,gun) {
    const order=getOrder();
    if (!order || !data?.canCommand || busy || uncertain) return;
    const starting=name==='start-charge';
    if (starting ? !mayStart(gun) : !active() || !!data.stop) return;
    clearTimeout(poll); busy=true; error=''; render();
    try {
      const value=starting ? await AFEApi.startSession(order.pass,data.target,['wallet','card'].includes(order.funding)) : await AFEApi.stopSession(order.pass,data.target);
      if (getOrder()!==order) return;
      if (!safeResult(value,order) || value.attemptId!==data.attemptId || !same(value.target,data.target) ||
          !(starting?value.start:value.stop)) throw new ChargeApiError(502,'COMMAND_RESULT_UNVERIFIED');
      data=value;
    } catch(e) {
      if (getOrder()===order) {
        error=e instanceof ChargeApiError?e.code:'COMMAND_DELIVERY_UNKNOWN'; uncertain=true;
        if (!starting) stopUnconfirmed=true;
      }
    } finally {busy=false;render();}
    if (getOrder()===order && !uncertain) void query();
  }
  function button(action,label) {
    return '<button class="rec-refresh" type="button" data-act="'+action+'"'+(busy?' disabled':'')+'>'+label+'</button>';
  }
  function detail(label,c,stationView) {
    if (!c) return '';
    const timestamp=(en,zh,value)=>stationView?'':pair(tr(en,zh),when(value));
    return '<h3>'+label+'</h3><dl class="rec-details">'+timestamp('Requested UTC','请求时间 UTC',c.requestedAt)+
      pair(tr('CPO response','CPO 受理结果'),c.ack)+timestamp('Acknowledged UTC','受理时间 UTC',c.acknowledgedAt)+
      pair(tr('Command result','指令回调结果'),c.callback)+timestamp('Callback UTC','回调时间 UTC',c.callbackAt)+'</dl>';
  }
  function card(gun,stationView=false) {
    const order=getOrder();
    const readiness = permitsCheckout(gun) ? tr('Remote commands are enabled for this connector.','此枪口已开通远程启停。')
      : capability?.reason==='PRODUCTION_APP_USER_NOT_CONFIGURED' && listed(gun)
        ? tr('Connector configured. Remote charging awaits AFE’s operator identity.','此枪口已配置，远程启停待确认 AFE 的服务商身份。')
        : tr('Remote charging is unavailable for this connector.','此枪口的远程启停暂不可用。');
    if (!order) return '<p>'+readiness+'</p>';
    let body='';
    if (data) {
      const s=data.session;
      if (s.state==='MATCHED') body+='<dl class="rec-details">'+(stationView?'':pair(tr('CPO session','CPO 会话'),s.id))+
        pair(tr('Session status','会话状态'),s.status)+pair(tr('Metered energy','已计量电量'),s.kwh!=null ? s.kwh+' kWh' : '')+'</dl>';
      else if (data.start) body+='<p>'+tr('Session verification','会话核验')+' · '+esc(s.state)+'</p>';
      if(['wallet','card'].includes(data.funding) && data.wallet){
        const w=data.wallet,amount=c=>'R'+(c/100).toFixed(2);
        if(data.funding==='card' && w.settlement==='PAYMENT_REQUIRED')body+='<p role="alert">'+tr('Card payment declined. The bill is outstanding.','银行卡扣款失败，本单仍待支付。')+'</p>';
        if(data.funding==='card' && w.settlement==='PAYMENT_PENDING')body+='<p role="status">'+tr('Checking the card payment with Peach…','正在向 Peach 核实扣款。')+'</p>';
        if(w.lowBalanceStop)body+='<p role="status">'+tr('AFE requested a stop because the wallet balance is running low.','余额接近用尽，AFE 已请求停充。')+'</p>';
        if(Number.isSafeInteger(w.costCents))body+='<dl class="rec-details">'+pair(tr('Final charging cost','最终充电费'),amount(w.costCents))+
          (w.shortfallCents?pair(tr('Shortfall on this order','本单待补差额'),amount(w.shortfallCents)):'')+'</dl>';
        else if(finished())body+='<p>'+tr('Waiting for the final charging bill.','正在等待海汇德的最终账单。')+'</p>';
        else if(Number.isSafeInteger(w.estimatedCents))body+='<dl class="rec-details">'+pair(tr('Estimated metered cost','按已计量电量估算'),amount(w.estimatedCents))+'</dl>';
      }
      body+=detail('START_SESSION',data.start,stationView)+detail('STOP_SESSION',data.stop,stationView);
      const stopFailed=[data.stop?.ack,data.stop?.callback].some(v=>v && v!=='ACCEPTED');
      if (active() && (stopUnconfirmed || stopFailed || (data.stop && (uncertain || !data.stop.ack)))) {
        body+='<p role="alert">'+tr('The session is still active. Use Stop on the charger or ask the site operator to end the session.','会话仍在充电。请在桩屏选择“停止充电”，或联系现场运营人员结束本次会话。')+'</p>';
      }
      if (!data.canCommand && ((capability?.enabled && getPayment()?.status==='AUTHORIZED') || (data.start && !finished()))) {
        body+='<button type="button" class="rec-refresh" data-account="order" data-id="'+esc(order.id)+'">'+tr('Resume charge controls','恢复本次充电操作')+'</button>';
      } else if (mayStart(gun)) {
        body+=button('start-charge',tr('Start charging','启动充电'));
      } else if (active() && data.canCommand && !data.stop && !uncertain) {
        body+=button('stop-charge',tr('Stop charging','停止充电'));
      }
    }
    if (error) body+='<p role="alert">'+tr('Check the CPO session status','请核对 CPO 会话状态')+' · '+esc(error)+'</p>';
    if (AFE_BASE_URL) body+=button('session-status',tr('Check charging status','查询充电状态'));
    if (!permitsCheckout(gun) && !data?.start) body+='<p>'+readiness+'</p>';
    return '<section class="rec-card"><h3>'+tr('Remote charging','远程充电')+'</h3>'+body+'</section>';
  }
  document.addEventListener('visibilitychange',()=>{if (!document.hidden && getOrder() && data?.start) void query();});
  function listed(gun) { return capability?.targets.some(t=>same(t,gun))===true; }
  function permitsCheckout(gun) { return capability?.enabled===true && listed(gun); }
  return {load,query,send,card,clear,permitsCheckout,mayStart,isBusy:()=>busy};
}
