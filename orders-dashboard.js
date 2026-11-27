'use strict';

function ordersDashboard({tr,esc,render,api,owner,getPage,sessionLocation,getPayments}){
  const ranges=[['7d','Last 7 days','近 7 天'],['30d','Last 30 days','近 30 天'],['year','This year','今年'],['all','All time','全部时间']];
  const labels={COMPLETED:['Completed','已完成'],CANCELLED:['Cancelled','已取消'],NO_ENERGY:['No energy delivered','未充入'],
    REJECTED:['Start declined','启动失败'],CLOSED_UNCONFIRMED:['Start timed out','启动超时已关闭'],CANCEL_PENDING:['Cancelling start','正在取消启动'],
    IN_PROGRESS:['Starting or charging','启动或充电中'],AWAITING_CDR:['Awaiting bill','待出账'],PAYMENT_PENDING:['Confirming payment','扣款待确认'],
    PAYMENT_REQUIRED:['Payment due','待支付'],NOT_STARTED:['Not started','待启动'],UNVERIFIED:['Awaiting verification','待核对']};
  let uid='',range='7d',revision=0,liveRevision=0,timer,totals=null,rows=[],cursor=null,more=false,failed=false,moreError=false;
  let current=null,live=null,liveError=false,grant=null,detail=null;
  const money=n=>Number.isSafeInteger(n)?'R '+(n/100).toFixed(2):'—';
  const energy=n=>Number.isFinite(n)?String(Number(n.toFixed(3)))+' kWh':'—';
  const label=o=>tr(...(labels[o.status] || labels.UNVERIFIED));
  const station=o=>esc(sessionLocation(o.target) || tr('Charging station','充电站'));
  const datetime=o=>esc(new Date(o.createdAt).toLocaleString(tr('en-ZA','zh-CN'),{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Johannesburg'}));
  const act=(name,text,id='')=>'<button type="button" class="text-action" data-account="'+name+'" data-id="'+esc(id)+'">'+text+'</button>';
  const visible=()=>!!uid && uid===owner() && getPage()==='orders';
  function leave(){++revision;++liveRevision;clearTimeout(timer);grant=null;}
  function enter(){
    leave();
    if(uid!==owner()){uid=owner();range='7d';detail=null;}
    rows=[];totals=null;current=null;live=null;liveError=false;
    if(visible()){void load(range);void pollCurrent();}
  }
  async function load(next){
    if(!ranges.some(([key])=>key===next) || !visible())return;
    range=next;
    const version=++revision,query='?range='+range;
    rows=[];totals=null;cursor=null;failed=false;more=false;moreError=false;render();
    try{
      const [summary,history]=await Promise.all([api('/me/orders/insights'+query),api('/me/orders/history'+query)]);
      if(version!==revision || !visible())return;
      if(!summary.totals || !Array.isArray(history.orders))throw new Error();
      totals=summary.totals;rows=history.orders;cursor=history.next;
    }catch{if(version===revision && visible())failed=true;}
    finally{if(version===revision && visible())render();}
  }
  async function loadMore(){
    if(!cursor || more || !visible())return;
    const version=revision;more=true;moreError=false;render();
    try{
      const page=await api('/me/orders/history?range='+range+'&after='+encodeURIComponent(cursor));
      if(version!==revision || !visible())return;
      const known=new Set(rows.map(o=>o.id));
      rows=rows.concat(page.orders.filter(o=>!known.has(o.id)));cursor=page.next;
    }catch{if(version===revision)moreError=true;}
    finally{if(version===revision){more=false;render();}}
  }
  async function pollCurrent(){
    clearTimeout(timer);
    if(!visible() || document.hidden)return;
    const version=++liveRevision,valid=()=>version===liveRevision && visible();
    let refreshHistory=false;
    try{
      const response=await api('/me/orders/current');
      if(!valid())return;
      const former=current?.id;
      current=response.current;liveError=false;
      if(former!==current?.id){live=null;grant=null;refreshHistory=!!former;}
      if(current){
        const id=current.id;
        if(grant?.attemptId!==id){
          const recovered=await api('/me/orders/'+encodeURIComponent(id)+'/resume','POST',{});
          if(!valid())return;
          grant=recovered;
        }
        if(!valid() || grant?.attemptId!==id)return;
        const value=getPayments().recentStatus(id) || await AFEApi.sessionStatus(grant.pass);
        if(!valid())return;
        if(value.attemptId!==id || !['country_code','party_id','location_id','evse_uid','connector_id'].every(k=>current.target?.[k]===value.target?.[k]))throw new Error();
        if(['SETTLED','CANCELLED','REJECTED','CLOSED_UNCONFIRMED','AWAITING_CDR','PAYMENT_PENDING','PAYMENT_REQUIRED'].includes(value.wallet?.settlement) ||
           value.cancellation==='CANCELLED' || (value.session?.state==='MATCHED' && ['COMPLETED','INVALID'].includes(value.session.status))){
          current=null;live=null;refreshHistory=true;
        }else{live=value;liveError=['LOOKUP_UNAVAILABLE','AMBIGUOUS','INVALID_RECORD'].includes(value.session?.state);}
      }
    }catch{if(valid()){liveError=true;live=null;}}
    finally{
      if(valid()){
        if(refreshHistory)void load(range);else render();
        if(!document.hidden)timer=setTimeout(pollCurrent,current?6000:15000);
      }
    }
  }
  document.addEventListener('visibilitychange',()=>{if(visible()){if(document.hidden){++liveRevision;clearTimeout(timer);}else void pollCurrent();}});
  const facts=o=>'<dl class="order-facts"><div><dt>'+tr('Energy delivered','充入电量')+'</dt><dd>'+energy(o.energyKwh)+'</dd></div><div><dt>'+
    tr('Amount charged','实际扣费')+'</dt><dd>'+money(o.paidCents)+'</dd></div></dl>';
  function historyRow(o){
    return '<article class="app-card history-order"><header><h3>'+station(o)+'</h3><span>'+label(o)+'</span></header><time>'+datetime(o)+'</time>'+facts(o)+
      (o.useTestCredit && Number.isSafeInteger(o.fundedCents)?'<small>'+tr('Paid from test credit','试充额度抵扣')+' '+money(o.fundedCents)+'</small>':'')+
      act('history-order',tr('View order','查看订单'),o.id)+'</article>';
  }
  function pinned(){
    if(!current)return liveError?'<p role="status">'+tr('Current charging status unavailable.','暂时无法获取当前充电状态。')+'</p>':'';
    const matched=live?.session?.state==='MATCHED' && live.session.status==='ACTIVE';
    const heading=matched?tr('Currently charging','当前充电中'):liveError?tr('Checking current order','正在核实本次充电'):tr('Current order · waiting for charger','当前订单 · 等待桩端');
    return '<button class="orders-current" type="button" data-act="return-charge" data-id="'+esc(current.id)+'"><strong>'+heading+'</strong><span>'+station(current)+
      '</span><span>'+tr('Energy delivered','已充电量')+' <b>'+energy(matched?live.session.kwh:null)+'</b> · '+tr('Estimated cost','预估费用')+' <b>'+money(matched?live.wallet?.estimatedCents:null)+
      '</b></span><span>'+tr('View charging details','查看充电详情')+' ›</span></button>';
  }
  function screen(){
    const filter='<div role="group" class="order-ranges" aria-label="'+tr('Date range','时间范围')+'">'+ranges.map(([key,en,zh])=>
      '<button type="button" aria-pressed="'+(range===key)+'" data-account="orders-range" data-id="'+key+'">'+tr(en,zh)+'</button>').join('')+'</div>';
    let body;
    if(failed)body='<p role="alert">'+tr('Could not load orders.','暂时无法读取订单。')+'</p>'+act('orders-range',tr('Retry','重试'),range);
    else if(!totals)body='<p role="status">'+tr('Loading orders…','正在读取订单…')+'</p>';
    else{
      const metrics=[[tr('Total spend','总花费'),money(totals.spendCents)],[tr('Total energy','总电量'),energy(totals.energyKwh)],
        [tr('Total sessions','充电次数'),String(totals.sessions)+tr('',' 次')]];
      const history=rows.filter(o=>o.id!==current?.id);
      body='<section class="app-card rec-card order-insights"><h2>'+tr('Charging insights','充电统计')+'</h2><dl>'+metrics.map(([k,v])=>'<div><dt>'+k+'</dt><dd>'+esc(v)+'</dd></div>').join('')+'</dl>'+
        (!totals.spendCents && !totals.sessions?'<p>'+tr('No spending in this period yet','该时段暂无充电消费')+'</p>':'')+'</section>'+
        '<section class="rec-card order-history"><h2>'+tr('Order history','历史订单')+'</h2>'+(history.map(historyRow).join('') ||
          '<p>'+tr('No past orders in this period.','该时段暂无历史订单。')+'</p>')+
        (moreError?'<p role="alert">'+tr('Could not load the next page.','暂时无法读取下一页。')+'</p>':'')+
        (cursor?'<button type="button" class="rec-refresh" data-account="orders-more"'+(more?' disabled':'')+'>'+tr(more?'Loading…':'Load more',more?'正在读取…':'加载更多')+'</button>':'')+'</section>';
    }
    return '<h1>'+tr('Orders','订单')+'</h1>'+pinned()+filter+body;
  }
  return {enter,leave,load,loadMore,screen,current:()=>current,
    select(id){detail=rows.find(o=>o.id===id);return !!detail;},
    detail:()=>detail && '<button class="text-action" data-page="orders">‹ '+tr('Orders','订单')+'</button><h1>'+tr('Order details','订单详情')+'</h1><section class="app-card rec-card">'+
      '<h2>'+station(detail)+'</h2><p>'+datetime(detail)+' · '+label(detail)+'</p>'+facts(detail)+(detail.useTestCredit && Number.isSafeInteger(detail.fundedCents)?
      '<p>'+tr('Paid from test credit','试充额度抵扣')+' '+money(detail.fundedCents)+'</p>':'')+
      (detail.shortfallCents || detail.outstandingCents?'<p>'+tr('Outstanding balance','本单待补金额')+' '+money(detail.shortfallCents || detail.outstandingCents)+'</p>':'')+
      (detail.operatorReviewCents?'<p>'+tr('Pending operator review','待运营核对差额')+' '+money(detail.operatorReviewCents)+'</p>':'')+
      (detail.lowBalanceStop?'<p>'+tr('Low-balance stop requested','已请求低余额停充')+'</p>':'')+
      (detail.preauthAmount?'<p>'+tr('Card preauthorisation','银行卡预授权')+' R '+esc(detail.preauthAmount)+'</p>':'')+'</section>'};
}
