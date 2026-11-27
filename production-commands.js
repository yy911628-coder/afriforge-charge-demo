'use strict';

function productionCommands({tr, esc, pair, render, password, getOrder, getPayment, targetValid, acceptsStationStatus, sessionLocation}) {
  const fields = ['country_code','party_id','location_id','evse_uid','connector_id'];
  const same = (a,b) => targetValid(a) && targetValid(b) && fields.every(key => a[key]===b[key]);
  const isoTime = input => typeof input==='string' && Number.isFinite(Date.parse(input));
  const flag = input => input == null || (typeof input==='string' && /^[A-Z0-9_]{1,48}$/.test(input));
  const when = input => isoTime(input) ? new Date(input).toISOString() : '';
  const sessionStates = ['NOT_STARTED','NOT_CHECKED','MATCHED','NOT_FOUND','AMBIGUOUS','INVALID_RECORD','LOOKUP_UNAVAILABLE'];
  const ocpiStates = ['PENDING','ACTIVE','COMPLETED','INVALID','RESERVATION'];
  let capability = null, data = null, busy = false, checkingAccess = false;
  let error = '', poll, socTimer, lastSession=null, sending='', queuedStop=null, uncertain = false, stopUnconfirmed = false;
  function clear() {
    clearTimeout(poll);clearTimeout(socTimer);lastSession=null;sending='';queuedStop=null;
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
  const finalBill=()=>data?.wallet?.settlement==='SETTLED' && Number.isSafeInteger(data.wallet.costCents);
  const closedStart=()=>data?.wallet?.settlement==='CLOSED_UNCONFIRMED' && !active();
  const declined=result=>!!result && result!=='ACCEPTED' && result!=='TIMEOUT';
  const refused=c=>declined(c?.ack) || declined(c?.callback);
  function failureText(code) {
    if(code==='TARGET_RESERVATION_UNVERIFIED')return tr('AFE could not confirm your access to this connector. No start was sent. Ask the site operator to check it.','AFE 尚未确认你的账户可使用这把枪。此次启动指令未发送，请联系场站核对。');
    if(code==='TARGET_RESERVATION_LOOKUP_UNAVAILABLE')return tr('Reservation details are unavailable. Try again.','暂时无法读取桩端预约，请重新查询。');
    if(code==='TARGET_VEHICLE_NOT_CONNECTED')return tr('The station reports the cable is disconnected. Check the plug.','桩端上报尚未连接，请核对所选枪口并插紧。');
    if(code==='TARGET_EVSE_NOT_AVAILABLE')return tr('The station reports this connector is busy or unavailable.','桩端上报此枪正在使用或暂不可用，请核对枪口。');
    return '';
  }
  function mayStart(gun) {
    const p=getPayment();
    return data?.canCommand && !uncertain && !data.start && data.session.state==='NOT_STARTED' &&
      permitsCheckout(data.target) && ((['wallet','card'].includes(getOrder()?.funding) && data.funding===getOrder().funding) ||
      (p?.status==='AUTHORIZED' && p.attemptId===data.attemptId && same(p.target,data.target))) &&
      same(gun,data.target) && gun.standard==='IEC_62196_T2_COMBO' &&
      ((['AVAILABLE','PREPARING'].includes(gun.status) && gun.vehicle_connection==='CONNECTED') || acceptsStationStatus(gun));
  }
  function pollSoon() {
    clearTimeout(poll);
    const waitingForBill=['wallet','card'].includes(data?.funding) && !['SETTLED','REJECTED','PAYMENT_REQUIRED'].includes(data.wallet?.settlement);
    if (data?.start && !finalBill() && !closedStart() && (!finished() || waitingForBill) && !refused(data.start) && !document.hidden) {
      poll=setTimeout(() => {
        if (document.hidden) return;
        if (document.activeElement?.matches('input,select')) {pollSoon();return;}
        void query();
      },finished()?15000:data.stop || !lastSession?4000:8000);
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
      if (value.session.state==='MATCHED') lastSession=value.session;
      if (value.stop?.ack==='ACCEPTED' || value.stop?.callback==='ACCEPTED') stopUnconfirmed=false;
      data=value; uncertain=false; pollSoon();window.dispatchEvent(new Event('afe-charge-update'));
      return value;
    } catch(e) {
      if (getOrder()===order) { error=e instanceof ChargeApiError?e.code:'SESSION_STATUS_UNAVAILABLE'; uncertain=true;pollSoon(); }
    } finally {
      busy=false;
      const stop=queuedStop;queuedStop=null;
      if(stop===order && getOrder()===order && active() && !uncertain && !data.stop)void send('stop-charge');
      render();
    }
  }
  async function send(name,gun) {
    const order=getOrder();
    const starting=name==='start-charge';
    if (!order || !data?.canCommand || uncertain) return;
    if(busy){
      if(!starting && !sending && active() && !data.stop){queuedStop=order;render();}
      return;
    }
    if (starting ? !mayStart(gun) : !active() || !!data.stop) return;
    clearTimeout(poll); busy=true; sending=name; error=''; render();
    try {
      const value=starting ? await AFEApi.startSession(order.pass,data.target,['wallet','card'].includes(order.funding)) : await AFEApi.stopSession(order.pass,data.target);
      if (getOrder()!==order) return;
      if (!safeResult(value,order) || value.attemptId!==data.attemptId || !same(value.target,data.target) ||
          !(starting?value.start:value.stop)) throw new ChargeApiError(502,'COMMAND_RESULT_UNVERIFIED');
      data=value;
    } catch(e) {
      if (getOrder()===order) {
        error=e instanceof ChargeApiError?e.code:'COMMAND_DELIVERY_UNKNOWN'; uncertain=!starting || !failureText(error);
        if (!starting) stopUnconfirmed=true;
      }
    } finally {busy=false;sending='';render();}
    if (getOrder()===order && (!uncertain || (starting && error==='OCPI_DELIVERY_UNCERTAIN'))) void query();
    else if(getOrder()===order)pollSoon();
  }
  function simulatedSoc() {
    const begun=Date.parse(lastSession?.startedAt || data.start.requestedAt);
    return Math.min(100,65+Math.floor(Math.max(0,Date.now()-begun)/10000));
  }
  function tickSoc(){
    clearTimeout(socTimer);
    if(document.hidden || !active() || finalBill() || Number.isFinite(lastSession?.soc) || !getOrder()?.useTestCredit)return;
    const n=simulatedSoc();
    document.querySelectorAll('[data-demo-soc]').forEach(el=>{el.textContent=n+'%';});
    document.querySelectorAll('[data-demo-battery]').forEach(el=>{el.style.setProperty('--soc',n+'%');});
    if(n<100)socTimer=setTimeout(tickSoc,10000-(Math.max(0,Date.now()-Date.parse(lastSession?.startedAt || data.start.requestedAt))%10000));
  }
  function screen() {
    if(!data?.start)return '';
    if(closedStart())return '<section class="app-card rec-card session-view"><h1>'+tr('Order closed','订单已关闭')+'</h1><p>'+esc(sessionLocation(data.target))+'</p><p class="session-message" role="status">'+
      tr('The start timed out. AFE closed this order without a debit.','启动超时，AFE 已关闭本单，本次未扣款。')+'</p><button type="button" class="rec-refresh" data-act="close-payment">'+tr('Done','完成')+'</button></section>';
    const w=data.wallet || {}, s=lastSession, done=finalBill() || s?.status==='COMPLETED' || s?.status==='INVALID';
    const failed=refused(data.start) && !done && s?.status!=='ACTIVE', stopFailed=refused(data.stop) || stopUnconfirmed || data.stop?.callback==='TIMEOUT';
    const stopWaiting=!done && !stopFailed && (queuedStop || sending==='stop-charge' || !!data.stop);
    const showLive=!done && s?.status==='ACTIVE';
    const heading=done ? tr('Charging bill','充电账单') : failed ? tr('Charging could not start','充电未启动') :
      stopWaiting ? tr('Stopping charging','正在停止充电') : showLive && (uncertain || !active()) ? tr('Checking charging status','正在核实充电状态') :
      showLive ? tr('Charging','充电中') :
      !s && data.start.ack!=='ACCEPTED' && data.start.callback!=='ACCEPTED' ? tr('Start unconfirmed','启动结果待确认') : tr('Waiting for the charger','等待充电桩启动');
    const amount=c=>'R'+(c/100).toFixed(2);
    const energy=Number.isFinite(w.energyKwh) && w.energyKwh>=0 ? w.energyKwh : s?.kwh;
    const terminalCost=Number.isSafeInteger(w.costCents) && w.costCents>=0;
    let body='',message='';
    if(done) {
      message=finalBill() ? (getOrder()?.useTestCredit ? tr('Settled using station test credit.','已使用本站试充额度结算。') : tr('Payment settled.','本单已结算。')) :
        w.settlement==='PAYMENT_REQUIRED'?tr('Payment is outstanding.','本单待付款。'):
        s?.status==='INVALID'?tr('The station marked this session invalid. Contact the operator.','桩端将本次会话标为无效，请联系现场运营人员核对。'):
        tr('Charging ended. Waiting for the final bill.','充电已结束，正在等待桩端最终账单。');
    } else if(stopFailed && showLive)message=tr('Stop is unconfirmed. Check the charger and use its Stop control if charging continues.','停止结果尚未确认。若桩屏仍在充电，请在桩屏停止本次会话。');
    else if(stopWaiting)message=tr('Waiting for the station to confirm the end of this session.','正在等待桩端确认本次充电已结束。');
    else if(failed)message=declined(data.start.callback) ?
      tr('The charger reported an unsuccessful start. Check its display.','桩端返回启动失败，请查看桩屏提示。') :
      tr('The operator declined the start request.','运营平台未受理启动请求。');
    else if(!showLive){
      if(data.start.callback==='TIMEOUT')message=tr('The charger response timed out. Check this order and the charger display.','桩端启动超时。请查看桩屏并刷新本单。');
      else if(data.start.callback==='ACCEPTED')message=tr('The charger accepted the start. Waiting for the charging session.','桩端已接受启动，正在等待充电会话。');
      else if(s?.status==='PENDING')message=tr('The operator reports a pending session.','运营平台已建立会话，正在等待桩端开始充电。');
      else if(s?.status==='RESERVATION')message=tr('The operator reports a reservation. Waiting for charging to begin.','运营平台已返回本单的预约记录，正在等待桩端开始充电。');
      else if(data.start.ack==='ACCEPTED')message=tr('The operator accepted the request. Waiting for the charger.','运营平台已受理，正在等待桩端启动结果。');
      else message=tr('AFE recorded your request. The operator’s receipt is pending. Check this order before starting again.','AFE 已登记，尚未收到运营平台的受理回执。请刷新本单查看进展，避免重复启动。');
    }
    if(showLive && !done) {
      const measured=Number.isFinite(s.soc) && s.soc>=0 && s.soc<=100;
      const demo=!measured && getOrder()?.useTestCredit===true;
      const pct=measured ? Math.round(s.soc) : demo ? simulatedSoc() : null;
      body='<div class="session-soc"><div class="session-battery" aria-hidden="true"><i '+(demo?'data-demo-battery ':'')+'style="--soc:'+(pct??0)+'%"></i></div><div><span>'+
        (demo?tr('Battery · demo SOC','车辆电量 · 模拟 SOC'):tr('Vehicle battery','车辆电量'))+'</span><strong '+(demo?'data-demo-soc':'')+'>'+
        (pct===null?tr('Not reported','暂未上报'):pct+'%')+'</strong></div></div>';
      if(demo)tickSoc();
    }
    if(showLive || done) {
      const metric=(label,value,unit='')=>'<div><span>'+label+'</span><strong>'+value+(unit?'<small>'+unit+'</small>':'')+'</strong></div>';
      body+='<div class="session-meters">'+metric(tr('Energy delivered','已充电量'),Number.isFinite(energy)?esc(String(Number(energy.toFixed(3)))):'—','kWh')+
        metric(terminalCost ? tr('Final cost','最终费用') : tr('Estimated cost','预估费用'),terminalCost ? amount(w.costCents) :
        Number.isSafeInteger(w.estimatedCents)?amount(w.estimatedCents):'—')+'</div>';
    }
    if(w.shortfallCents>0)body+='<p>'+tr('Outstanding balance','本单待补金额')+' '+amount(w.shortfallCents)+'</p>';
    if(w.operatorReviewCents>0)body+='<p>'+tr('Pending operator review','待运营核对差额')+' '+amount(w.operatorReviewCents)+'</p>';
    if(w.lowBalanceStop && !done)message=tr('The wallet is running low. AFE has requested a stop.','钱包余额接近用尽，AFE 已申请停充。');
    if((uncertain || (s && data.session.state!=='MATCHED' && !stopWaiting)) && !done)message+=' '+tr('Updating station readings.','正在核实最新桩端读数。');
    const progress=(!showLive && !done && !failed) || stopWaiting;
    const place=sessionLocation(data.target);
    return '<section class="app-card rec-card session-view" aria-label="'+heading+'"><h1>'+heading+'</h1>'+
      (place?'<p class="session-place">'+esc(place)+'</p>':'')+body+
      (message?'<p class="session-message" role="status">'+(progress?'<i class="session-spinner" aria-hidden="true"></i>':'')+message+'</p>':'')+
      (done || failed?'<button type="button" class="rec-refresh" data-act="close-payment">'+tr('Close','关闭')+'</button>':'')+
      (!finalBill() && !failed?button('session-status',tr('Refresh charging status','更新充电状态')):'')+
      (!data.canCommand && !done && !failed?'<button class="rec-refresh" type="button" data-account="order" data-id="'+esc(getOrder().id)+'">'+tr('Resume charge controls','恢复本次充电操作')+'</button>':'')+'</section>';
  }
  function sessionFooter() {
    if(!data?.start || finalBill() || closedStart() || lastSession?.status!=='ACTIVE' || !data.canCommand)return '';
    const stopping=queuedStop || sending==='stop-charge' || data.stop;
    return '<button type="button" class="station-primary session-stop" data-act="stop-charge"'+(stopping || uncertain || !active()?' disabled':'')+'>'+
      (stopping ? tr('Stop requested','已申请停止充电') : tr('Stop charging','停止充电'))+'</button>';
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
      } else if (!stationView && mayStart(gun)) {
        body+=button('start-charge',tr('Start charging','启动充电'));
      } else if (active() && data.canCommand && !data.stop && !uncertain) {
        body+=button('stop-charge',tr('Stop charging','停止充电'));
      }
    }
    if (error) body+='<p role="alert">'+(failureText(error) || esc(error))+'</p>';
    if (AFE_BASE_URL) body+=button('session-status',tr('Check charging status','查询充电状态'));
    if (!permitsCheckout(gun) && !data?.start) body+='<p>'+readiness+'</p>';
    return '<section class="rec-card"><h3>'+tr('Remote charging','远程充电')+'</h3>'+body+'</section>';
  }
  document.addEventListener('visibilitychange',()=>{if (!document.hidden && getOrder() && data?.start) void query();});
  function listed(gun) { return capability?.targets.some(t=>same(t,gun))===true; }
  function permitsCheckout(gun) { return capability?.enabled===true && listed(gun); }
  return {load,query,send,card,screen,sessionFooter,failureText,lastProblem:()=>failureText(error),clear,permitsCheckout,mayStart,isBusy:()=>busy,hasStart:()=>!!data?.start};
}
