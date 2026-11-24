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
      capability?.enabled && p?.status==='AUTHORIZED' && p.attemptId===data.attemptId && same(p.target,data.target) &&
      same(capability.target,data.target) && same(gun,data.target) && gun.standard==='IEC_62196_T2_COMBO' && gun.status==='AVAILABLE';
  }
  function pollSoon() {
    clearTimeout(poll);
    if (data?.start && !finished() && !['REJECTED','NOT_SUPPORTED'].includes(data.start.ack) &&
        !['REJECTED','FAILED'].includes(data.start.callback) && !document.hidden) {
      poll=setTimeout(() => {
        if (document.hidden) return;
        if (document.activeElement?.matches('input,select')) {pollSoon();return;}
        void query();
      },12000);
    }
  }
  async function load() {
    if (!AFE_BASE_URL || checkingAccess) return;
    checkingAccess=true;
    try {
      const value=await AFEApi.commandCapabilities();
      capability=value.enabled===true && targetValid(value.target) ? value : {enabled:false};
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
      data=value; uncertain=false; pollSoon();
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
      const value=starting ? await AFEApi.startSession(order.pass,data.target) : await AFEApi.stopSession(order.pass,data.target);
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
  function detail(label,c) {
    if (!c) return '';
    return '<h3>'+label+'</h3><dl class="rec-details">'+pair(tr('Requested UTC','请求时间 UTC'),when(c.requestedAt))+
      pair(tr('CPO response','CPO 受理结果'),c.ack)+pair(tr('Acknowledged UTC','受理时间 UTC'),when(c.acknowledgedAt))+
      pair(tr('Command result','指令回调结果'),c.callback)+pair(tr('Callback UTC','回调时间 UTC'),when(c.callbackAt))+'</dl>';
  }
  function card(gun) {
    const order=getOrder();
    if (!order) return '<p>'+(capability?.enabled?tr('Remote charging requires a verified preauthorisation.','须核验预授权后才能远程启动。'):
      tr('Remote start is not enabled.','远程启动尚未开通。'))+'</p>';
    let body='';
    if (data) {
      const s=data.session;
      if (s.state==='MATCHED') body+='<dl class="rec-details">'+pair(tr('CPO session','CPO 会话'),s.id)+
        pair(tr('Session status','会话状态'),s.status)+pair(tr('Metered energy','已计量电量'),s.kwh!=null ? s.kwh+' kWh' : '')+'</dl>';
      else if (data.start) body+='<p>'+tr('Session verification','会话核验')+' · '+esc(s.state)+'</p>';
      body+=detail('START_SESSION',data.start)+detail('STOP_SESSION',data.stop);
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
    if (!capability?.enabled && !data?.start) body+='<p>'+tr('Remote start is not enabled.','远程启动尚未开通。')+'</p>';
    return '<section class="rec-card"><h3>'+tr('Remote charging','远程充电')+'</h3>'+body+'</section>';
  }
  document.addEventListener('visibilitychange',()=>{if (!document.hidden && getOrder() && data?.start) void query();});
  function permitsCheckout(gun) { return capability?.enabled===true && same(capability.target,gun); }
  return {load,query,send,card,clear,permitsCheckout,mayStart,isBusy:()=>busy};
}
