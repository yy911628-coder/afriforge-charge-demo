'use strict';

function productionCommands({tr, esc, pair, render, password, getOrder, getPayment, targetValid, acceptsStationStatus, sessionLocation, gunName,onStation,onCancelled,toast}) {
  const fields = ['country_code','party_id','location_id','evse_uid','connector_id'];
  const same = (a,b) => targetValid(a) && targetValid(b) && fields.every(key => a[key]===b[key]);
  const isoTime = input => typeof input==='string' && Number.isFinite(Date.parse(input));
  const flag = input => input == null || (typeof input==='string' && /^[A-Z0-9_]{1,48}$/.test(input));
  const when = input => isoTime(input) ? new Date(input).toISOString() : '';
  const sessionStates = ['NOT_STARTED','NOT_CHECKED','MATCHED','NOT_FOUND','AMBIGUOUS','INVALID_RECORD','LOOKUP_UNAVAILABLE'];
  const ocpiStates = ['PENDING','ACTIVE','COMPLETED','INVALID','RESERVATION'];
  let capability = null, data = null, busy = false, checkingAccess = false;
  let error = '', poll, socTimer, durationTimer, lastSession=null, sending='', queuedStop=null, uncertain = false, stopUnconfirmed = false;
  let cancelFlight=null,statusFlight=null,cancelExpected=false,cancelError=false,chargeWon=false,wait=null,waitTimer,openPrompt=null,lastLookup=0;
  const slowText=()=>tr('The charger is responding slowly. Check that the cable is plugged in. You can keep waiting, or cancel and scan again.','桩端响应较慢，请检查是否已插好枪。您可以继续等待，或取消后重新扫码。');
  const clockKey='afe.start-wait.'+AFE_BASE_URL;
  function savedClock(){try{return JSON.parse(sessionStorage.getItem(clockKey));}catch{return null;}}
  function saveClock(){try{sessionStorage.setItem(clockKey,JSON.stringify(wait));}catch{}}
  function clear() {
    clearTimeout(waitTimer);dismissPrompt();wait=null;cancelFlight=null;cancelExpected=false;cancelError=false;chargeWon=false;lastLookup=0;
    clearTimeout(poll);clearTimeout(socTimer);clearTimeout(durationTimer);lastSession=null;sending='';queuedStop=null;
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
  const isClosed=()=>!!data && (data.cancellation==='CANCELLED' || finalBill() || closedStart() || data.wallet?.settlement==='REJECTED' ||
    (refused(data.start) && data.cancellation!=='REQUESTED' && !active() && !finished()));
  function failureText(code) {
    if(code==='TARGET_RESERVATION_UNVERIFIED')return tr('AFE could not confirm your access to this connector. No start was sent. Ask the site operator to check it.','AFE 尚未确认你的账户可使用这把枪。此次启动指令未发送，请联系场站核对。');
    if(code==='TARGET_RESERVATION_LOOKUP_UNAVAILABLE')return tr('Reservation details are unavailable. Try again.','暂时无法读取桩端预约，请重新查询。');
    if(code==='TARGET_VEHICLE_NOT_CONNECTED')return tr('The station reports the cable is disconnected. Check the plug.','桩端上报尚未连接，请核对所选枪口并插紧。');
    if(code==='TARGET_EVSE_NOT_AVAILABLE')return tr('The station reports this connector is busy or unavailable.','桩端上报此枪正在使用或暂不可用，请核对枪口。');
    return '';
  }
  function mayStart(gun) {
    const p=getPayment();
    return data?.canCommand && !uncertain && !data.cancellation && !data.start && data.session.state==='NOT_STARTED' &&
      permitsCheckout(data.target) && ((['wallet','card'].includes(getOrder()?.funding) && data.funding===getOrder().funding) ||
      (p?.status==='AUTHORIZED' && p.attemptId===data.attemptId && same(p.target,data.target))) &&
      same(gun,data.target) && gun.standard==='IEC_62196_T2_COMBO' &&
      ((['AVAILABLE','PREPARING'].includes(gun.status) && gun.vehicle_connection==='CONNECTED') || acceptsStationStatus(gun));
  }
  function pollSoon() {
    clearTimeout(poll);
    const waitingForBill=['wallet','card'].includes(data?.funding) && !['SETTLED','REJECTED','PAYMENT_REQUIRED'].includes(data.wallet?.settlement);
    if (data?.start && !finalBill() && !closedStart() && data.cancellation!=='CANCELLED' &&
        (!finished() || waitingForBill) && (!refused(data.start) || active() || data.cancellation==='REQUESTED') && !document.hidden) {
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
  function waiting(){
    return !!data?.start && !isClosed() && !data.stop && !finished() && !chargeWon &&
      !(lastSession?.status==='ACTIVE' && (!active() || lastSession.kwh>0)) && data.cancellation!=='STARTED' &&
      !['AWAITING_CDR','PAYMENT_PENDING','PAYMENT_REQUIRED'].includes(data.wallet?.settlement);
  }
  function waitClock(){
    const id=getOrder()?.id;
    if(wait?.id===id)return wait;
    const saved=savedClock();
    wait=saved?.id===id && Number.isFinite(saved.at) && saved.at<=Date.now()?saved:{id,at:Date.now(),prompted:false};
    saveClock();
    return wait;
  }
  function dismissPrompt(){
    const dialog=openPrompt;openPrompt=null;
    if(dialog){dialog.close();dialog.remove();}
  }
  function showPrompt(kind){
    if(!onStation() || !waiting() || !data.canCommand || cancelFlight || data.cancellation==='REQUESTED')return;
    const order=getOrder();
    dismissPrompt();
    const dialog=document.createElement('dialog');openPrompt=dialog;
    dialog.className='start-cancel-dialog';dialog.setAttribute('aria-labelledby','start-cancel-question');
    const question=kind==='slow'?slowText():tr('Cancel this start? No fees have been incurred.','确定要取消启动吗？本次未产生费用。');
    dialog.innerHTML='<h2 id="start-cancel-question"></h2><div><button type="button" data-wait autofocus></button><button type="button" data-cancel></button></div>';
    dialog.querySelector('h2').textContent=question;
    const stay=dialog.querySelector('[data-wait]'),cancel=dialog.querySelector('[data-cancel]');
    stay.textContent=tr('Keep waiting','继续等待');cancel.textContent=tr('Cancel start','取消启动');
    stay.onclick=dismissPrompt;
    cancel.onclick=()=>{dismissPrompt();if(getOrder()!==order)return;if(kind==='slow')showPrompt('confirm');else void cancelStart();};
    dialog.oncancel=event=>{event.preventDefault();dismissPrompt();};
    document.body.append(dialog);dialog.showModal();
  }
  function syncWaitView(){
    clearTimeout(waitTimer);
    if(!onStation() || !waiting() || document.hidden || !data.canCommand || cancelFlight || data.cancellation==='REQUESTED'){
      dismissPrompt();return;
    }
    const clock=waitClock(),elapsed=Math.max(0,Date.now()-clock.at);
    if(elapsed>=180000 && !clock.prompted){
      clock.prompted=true;
      saveClock();
      if(!openPrompt)showPrompt('slow');
    }else if(elapsed<180000){
      waitTimer=setTimeout(render,(elapsed<90000?90000:180000)-elapsed);
    }
  }
  function observeCancellation(value){
    if(chargeWon)return;
    if(!cancelExpected && value.start){
      const saved=wait || savedClock();
      if(saved && saved.id===getOrder()?.id && saved.requested)cancelExpected=true;
    }
    if(value.cancellation==='REQUESTED')cancelExpected=true;
    if(!cancelExpected && !cancelFlight)return;
    if(finished() && value.cancellation!=='CANCELLED' && value.cancellation!=='REQUESTED'){
      cancelFlight=null;cancelExpected=false;cancelError=false;dismissPrompt();waitClock().requested=false;saveClock();
      toast(tr('Charging has ended. Check this order for the final bill.','本次充电已结束，请查看订单账单。'));return;
    }
    if(active() || value.cancellation==='STARTED' || (value.session.state==='MATCHED' && value.session.kwh>0)){
      chargeWon=true;cancelFlight=null;cancelExpected=false;cancelError=false;dismissPrompt();
      waitClock().requested=false;
      saveClock();
      toast(tr('Your vehicle has started charging. The cancellation is no longer valid.','车辆已开始充电，取消请求已失效。'));
    }else if(value.cancellation==='CANCELLED'){
      cancelFlight=null;cancelExpected=false;dismissPrompt();waitClock().requested=false;saveClock();
      toast(tr('Start cancelled','已取消启动'));onCancelled();
    }
  }
  async function cancelStart(){
    const order=getOrder();
    if(!order || !waiting() || !data.canCommand || cancelFlight || data.cancellation==='REQUESTED')return;
    const ticket={order};cancelFlight=ticket;cancelExpected=true;cancelError=false;render();
    waitClock().requested=true;
    saveClock();
    try{
      const value=await AFEApi.cancelStart(order.pass,data.target);
      if(cancelFlight!==ticket || getOrder()!==order)return;
      if(!safeResult(value,order) || !['REQUESTED','STARTED','CANCELLED'].includes(value.cancellation))throw new Error();
      // Finish any meter read already in flight before accepting a terminal cancellation.
      if(value.cancellation==='CANCELLED' && statusFlight){
        await statusFlight;
        if(cancelFlight!==ticket || getOrder()!==order)return;
      }
      if(value.session.state==='MATCHED')lastSession=value.session;
      data=value;uncertain=false;observeCancellation(value);
    }catch(e){
      if(e?.code==='ORDER_ALREADY_ENDED' && cancelFlight===ticket){
        cancelExpected=false;waitClock().requested=false;saveClock();
        toast(tr('This order has already ended. Updating its final status.','本单已结束，正在更新最终状态。'));
      }
      if(cancelFlight===ticket && getOrder()===order)cancelError=true;
    }finally{
      if(cancelFlight===ticket)cancelFlight=null;
      if(getOrder()===order){render();if(!busy)void query();}
    }
  }
  async function query(replacement, storeOriginal) {
    const order=getOrder();
    if (!order || busy || !AFE_BASE_URL) return;
    clearTimeout(poll);
    const pass=replacement || order.pass;
    let finishRead;
    const flight=new Promise(done=>{finishRead=done;});statusFlight=flight;
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
      // A read begun before the cancel POST must not undo an acknowledged cancellation request.
      if(data?.cancellation==='REQUESTED' && !value.cancellation)value.cancellation='REQUESTED';
      data=value; uncertain=false;lastLookup=Date.now();observeCancellation(value);pollSoon();window.dispatchEvent(new Event('afe-charge-update'));
      return value;
    } catch(e) {
      if (getOrder()===order) { error=e instanceof ChargeApiError?e.code:'SESSION_STATUS_UNAVAILABLE'; uncertain=true;pollSoon(); }
    } finally {
      if(statusFlight===flight)statusFlight=null;
      finishRead();
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
  function durationText(began) {
    if(!isoTime(began))return '—';
    const sec=Math.max(0,Math.floor((Date.now()-Date.parse(began))/1000));
    return [Math.floor(sec/3600),Math.floor(sec/60)%60,sec%60].map(n=>String(n).padStart(2,'0')).join(':');
  }
  function tickDuration(){
    clearTimeout(durationTimer);
    if(document.hidden || !active() || finalBill())return;
    durationTimer=setTimeout(()=>{
      const nodes=document.querySelectorAll('[data-charge-duration]');
      if(!nodes.length)return;
      for(const el of nodes)el.textContent=durationText(lastSession?.startedAt);
      tickDuration();
    },1000);
  }
  function screen() {
    if(!data?.start)return '';
    const w=data.wallet || {}, s=lastSession, settled=finalBill();
    const matched=data.session.state==='MATCHED' && !uncertain;
    const ended=settled || finished() || ['AWAITING_CDR','PAYMENT_PENDING','PAYMENT_REQUIRED'].includes(w.settlement);
    const cancelled=data.cancellation==='CANCELLED';
    const closed=closedStart() || cancelled, failed=!ended && !active() && (refused(data.start) || w.settlement==='REJECTED');
    const stopping=!ended && (queuedStop || sending==='stop-charge' || !!data.stop);
    const stopFailed=stopping && (refused(data.stop) || stopUnconfirmed || data.stop?.callback==='TIMEOUT');
    const receiving=matched && active() && Number.isFinite(s?.kwh) && s.kwh>0;
    const confirmed=matched || data.start.callback==='ACCEPTED';
    const amount=c=>'R'+(c/100).toFixed(2);
    const gun=gunName(data.target) || tr('connector','充电枪');
    const zero=settled && w.energyKwh===0 && w.costCents===0;
    let heading,message='';
    if(cancelled){heading=tr('Start cancelled','已取消启动');}
    else if(closed){heading=tr('Order closed','订单已关闭');message=tr('The charger did not confirm the start in time. No debit.','桩端启动超时，本次未扣款。');}
    else if(ended){
      heading=settled?tr('Charging bill','充电账单'):tr('Charging ended','充电已结束');
      if(zero)message=tr('No energy delivered. You were charged R0.00.','本次未充入电量，已扣 R0.00');
      else if(settled)message=getOrder()?.useTestCredit?tr('Paid with station test credit.','已使用本站试充额度结算。'):tr('Payment settled.','本单已结算。');
      else if(w.settlement==='PAYMENT_REQUIRED')message=tr('Payment is outstanding.','本单待付款。');
      else if(w.settlement==='PAYMENT_PENDING')message=tr('Checking the bank card payment.','正在核实本次银行卡扣款。');
      else if(s?.status==='INVALID')message=tr('The station marked this session invalid. Contact the station.','桩端将本次会话标为无效，请联系场站。');
      else message=tr('Waiting for the final bill from the station.','正在等待桩端最终账单。');
    }else if(stopFailed){heading=tr('Stop unconfirmed','停止结果待确认');message=tr('Check the charger display. If it is still charging, use Stop on the charger.','请核对桩屏。若仍在充电，请在桩屏停止。');}
    else if(stopping){heading=tr('Stopping charging','正在停止充电');message=tr('Waiting for the charger to finish.','正在等待桩端结束');}
    else if(failed){heading=tr('Charging could not start','充电未启动');message=tr('The operator or charger declined the start. Check the charger display.','桩端或运营平台已拒绝启动，请查看桩屏提示。');}
    else if(uncertain || (s?.status==='ACTIVE' && !matched)){heading=tr('Checking charging status','正在核实充电状态');message=tr('Waiting for current readings from the charger.','正在核实桩端最新读数。');}
    else if(receiving || chargeWon || data.cancellation==='STARTED'){
      heading=tr('Charging','正在充电');
      if(!receiving)message=tr('Charging has started. Waiting for the first meter reading.','桩端已启动，正在等待首笔电表读数。');
    }
    else if(confirmed){heading=tr('Waiting for meter readings','等待电表读数');message=tr('The charger accepted the start. Waiting for the meter.','桩端已受理，等待电表读数');}
    else{
      heading=tr('Start submitted for '+gun,'已提交 '+gun+'启动请求');
      message=data.start.callback==='TIMEOUT'?tr('Charger response timed out. Check this order.','桩端回应超时，请查看本次订单。'):
        data.start.ack==='ACCEPTED'?tr('The operator received your request. Waiting for the charger.','平台已收到请求，正在等待桩端确认。'):
        tr('Waiting for the operator to acknowledge your request.','正在等待平台确认收到请求。');
    }
    const elapsed=Date.now()-Date.parse(data.start.requestedAt);
    const longWait=!closed && !settled && !receiving && (elapsed>=30000 || failed || stopFailed || data.start.callback==='TIMEOUT');
    const mayCancel=data.canCommand && waiting();
    const cancelling=!!cancelFlight || data.cancellation==='REQUESTED';
    if(mayCancel && onStation() && Date.now()-waitClock().at>=90000)message=slowText();
    if(cancelling && !active())message=tr('Cancellation requested. Waiting for the charger to confirm the result.','已申请取消，正在核对桩端是否已启动。');
    if(cancelError && mayCancel && !cancelling)message=tr('Could not confirm cancellation. Refresh or try cancelling again.','暂时无法确认取消结果，请刷新状态或重试。');
    const metric=(label,value,unit='')=>'<div><span>'+label+'</span><strong>'+value+(unit?'<small>'+unit+'</small>':'')+'</strong></div>';
    const energy=Number.isFinite(w.energyKwh)?w.energyKwh:s?.kwh;
    const haveReading=ended || receiving || (stopping && matched && s?.kwh>0);
    const finalCost=Number.isSafeInteger(w.costCents) && w.costCents>=0;
    const covered=settled?Math.max(0,w.costCents-(w.shortfallCents || 0)-(w.operatorReviewCents || 0)):null;
    const price=settled?amount(covered):finalCost?amount(w.costCents):haveReading && Number.isSafeInteger(w.estimatedCents)?amount(w.estimatedCents):'—';
    let body=closed || failed?'':'<div class="session-meters">'+metric(tr('Energy delivered','已充电量'),haveReading && Number.isFinite(energy)?esc(energy===0?'0.00':String(Number(energy.toFixed(3)))):'—','kWh')+
      metric(settled?tr('Amount charged','实扣金额'):finalCost?tr('Final cost','最终费用'):tr('Estimated cost','预估费用'),price)+'</div>';
    if(s && active() && !ended){
      body+='<p class="session-duration">'+tr('Elapsed time','充电时长')+' <strong data-charge-duration>'+durationText(s.startedAt)+'</strong></p>';
      if(s.startedAt)tickDuration();
      const measured=Number.isFinite(s.soc) && s.soc>=0 && s.soc<=100;
      const demo=!measured && receiving && getOrder()?.useTestCredit===true;
      if(measured || demo){
        const pct=measured?Math.round(s.soc):simulatedSoc();
        body+='<div class="session-soc"><div class="session-battery" aria-hidden="true"><i '+(demo?'data-demo-battery ':'')+'style="--soc:'+pct+'%"></i></div><div><span>'+
          (demo?tr('Demo SOC','演示 SOC'):tr('Vehicle battery','车辆电量'))+'</span><strong '+(demo?'data-demo-soc':'')+'>'+pct+'%</strong></div></div>';
        if(demo)tickSoc();
      }
    }
    if(w.shortfallCents>0)body+='<p>'+tr('Outstanding balance','本单待补金额')+' '+amount(w.shortfallCents)+'</p>';
    if(w.operatorReviewCents>0)body+='<p>'+tr('Pending operator review','待运营核对差额')+' '+amount(w.operatorReviewCents)+'</p>';
    if(w.lowBalanceStop && !ended && !closed)message=tr('The wallet is running low. AFE requested a stop.','钱包余额接近用尽，AFE 已申请停充。');
    const place=sessionLocation(data.target);
    const stationPhone=data.target.location_id==='ZA41020001000001'?'<a class="text-action" href="tel:+27687259103">'+tr('Contact station','联系场站')+'</a>':'';
    const help=longWait?'<div class="session-help"><button class="text-action" type="button" data-page="order-info">'+tr('View this order','查看本次订单')+'</button>'+stationPhone+'</div>':'';
    return '<section class="app-card rec-card session-view"><h1>'+heading+'</h1>'+
      (place?'<p class="session-place">'+esc(place)+'</p>':'')+body+
      (message?'<p class="session-message" role="status">'+(!ended && !closed && !failed && !stopFailed?'<i class="session-spinner" aria-hidden="true"></i>':'')+message+'</p>':'')+help+
      (isClosed()?'<button type="button" class="rec-refresh" data-act="rescan-closed">'+tr('Scan again','重新扫码')+'</button>':'')+
      (ended || closed || failed?'<button type="button" class="text-action" data-act="close-payment">'+tr('Done','完成')+'</button>':'')+
      (!isClosed()?button('session-status',tr('Refresh charging status','更新充电状态')):'')+
      (mayCancel?'<button type="button" class="text-action cancel-start" data-act="cancel-start"'+(cancelling?' disabled aria-busy="true"':'')+'>'+(cancelling?tr('Cancelling...','正在取消...'):tr('Cancel start','取消启动'))+'</button>':'')+
      (!data.canCommand && !ended && !closed && !failed?'<button class="rec-refresh" type="button" data-account="order" data-id="'+esc(getOrder().id)+'">'+tr('Resume charge controls','恢复本次充电操作')+'</button>':'')+'</section>';
  }
  function sessionFooter() {
    if(!data?.start || isClosed() || finished() || ['AWAITING_CDR','PAYMENT_PENDING','PAYMENT_REQUIRED'].includes(data.wallet?.settlement) || lastSession?.status!=='ACTIVE' || !data.canCommand)return '';
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
  return {load,query,send,card,screen,sessionFooter,failureText,syncWaitView,showCancel:()=>showPrompt('confirm'),
    pendingRead:()=>statusFlight,recentStatus:id=>!uncertain && data?.attemptId===id && Date.now()-lastLookup<6000?data:null,
    lastProblem:()=>failureText(error),clear,permitsCheckout,mayStart,isClosed,hasEvidence:()=>!!data,isBusy:()=>busy,hasStart:()=>!!data?.start};
}
