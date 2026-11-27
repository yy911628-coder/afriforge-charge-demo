'use strict';

function walletRefundPage({tr,esc,api,owner,render,getPage,announce,describe,loadWallet,card,action,form,field,money}) {
  const endpoint='/me/wallet/refunds';
  let data=null,failed=false,choice='',revision=0;
  const labels={
    REFUNDED:['Refund sent','已原路退回'],
    FAILED:['Refund failed · amount returned to wallet','退款失败 · 金额已退回钱包'],
    PENDING:['Processing','处理中']
  };
  const label=state=>tr(...(labels[state] || labels.PENDING));
  const original=source=>source.card?esc(source.card.brand)+' ···· '+esc(source.card.last4):tr('Original payment card','原充值银行卡');
  const date=value=>esc(new Date(value).toLocaleString(tr('en-ZA','zh-CN')));
  async function load() {
    const user=owner(),n=++revision;
    if(!user)return;
    try {
      const result=await api(endpoint);
      if(n!==revision || owner()!==user)return;
      if(typeof result.enabled!=='boolean' || !Array.isArray(result.sources) || !Array.isArray(result.refunds))throw new Error();
      data=result;failed=false;
    } catch {
      if(n!==revision || owner()!==user)return;
      data=null;failed=true;
    } finally {if(n===revision && getPage()==='wallet-refunds')render();}
  }
  function enter(){data=null;failed=false;choice='';void load();}
  function select(id){choice=id;render();}
  function screen(){
    if(!data)return card(failed?action('reload-refunds',tr('Retry loading refunds','重新读取退款信息')):'<p>'+tr('Loading refundable top-ups…','正在读取可退款充值…')+'</p>');
    let content='';
    if(!data.enabled)content='<p>'+tr('Bank refunds will open when Peach activates live payments for AFE.','Peach 为 AFE 开通正式商户后，即可办理银行卡原路退款。')+'</p>';
    else if(data.unsettled)content='<p>'+tr('You can request a refund once your current charging order settles.','当前充电订单结清后可办理退款。')+'</p>';
    else if(!data.sources.length)content='<p>'+tr('No unused card top-ups are available to refund.','目前没有可原路退回的充值余额。')+'</p>';
    else content='<p>'+tr('Choose the top-up to refund to its original card.','请选择一笔充值，款项将退回该笔充值使用的银行卡。')+'</p>';
    for(const source of data.sources){
      const canRequest=data.enabled && !data.unsettled && !source.pending;
      let item='<strong>'+original(source)+'</strong><p>'+date(source.createdAt)+' · '+tr('Top-up','充值')+' '+money(source.originalCents)+'</p>'+
        '<p>'+tr('Available to refund','可退金额')+' <strong>'+money(source.remainingCents)+'</strong></p>';
      if(source.pending)item+='<p>'+tr('A refund for this top-up is processing.','这笔充值有一项退款正在处理。')+'</p>';
      if(canRequest && choice===source.reference){
        const maximum=(source.remainingCents/100).toFixed(2);
        item+=form('wallet-refund',field('amount',tr('Refund amount (ZAR)','退款金额（兰特）'),'number',
          'min="0.01" step="0.01" inputmode="decimal" required max="'+maximum+'"',maximum),tr('Confirm refund','确认原路退款'));
      }else if(canRequest)item+=action('select-refund',tr('Request refund','申请退款'),source.reference);
      content+='<article class="acct-item">'+item+'</article>';
    }
    content+='<small>'+tr('Station test credit can only be used for charging.','本站试充额度仅可用于充电。')+'</small>';
    const items=data.refunds.map(r=>'<article class="acct-item"><strong>'+money(r.amountCents)+' · '+label(r.state)+'</strong><p>'+date(r.createdAt)+'</p></article>').join('');
    let history=items || '<p>'+tr('No refund requests yet.','暂无退款记录。')+'</p>';
    if(data.refunds.length)history+='<p>'+tr('Your bank sets the posting date.','银行卡实际到账时间以发卡行为准。')+'</p>';
    if(data.refunds.some(r=>r.state==='PENDING'))history+='<a class="text-action" href="tel:+27687259103">'+tr('Ask about a pending refund','查询处理中的退款')+' · +27 68 725 9103</a>';
    return card(content)+card('<h2>'+tr('Refund history','退款记录')+'</h2>'+history+action('reload-refunds',tr('Refresh','刷新')));
  }
  async function submit(value){
    const user=owner(),source=data?.sources.find(s=>s.reference===choice);
    if(!user || !data?.enabled || data.unsettled || !source || source.pending)return;
    const cents=Math.round(Number(value)*100);
    if(!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(value) || cents<=0 || cents>source.remainingCents){
      announce(tr('Enter an amount within the refundable balance.','请输入可退余额范围内的金额。'),true);return;
    }
    if(!confirm(tr('Refund '+money(cents)+' to the card used for this top-up?','确认将 '+money(cents)+' 退回本次充值使用的银行卡吗？')))return;
    const key=['afe.refund',AFE_BASE_URL,user,source.reference,source.remainingCents,cents].join(':');
    let requestId=sessionStorage.getItem(key);
    if(!requestId){requestId=crypto.randomUUID();sessionStorage.setItem(key,requestId);}
    try {
      const {refund:result}=await api(endpoint,'POST',{requestId,reference:source.reference,amount:(cents/100).toFixed(2),quotedCents:source.remainingCents});
      if(!Object.hasOwn(labels,result.state))throw new Error();
      sessionStorage.removeItem(key);
      if(owner()!==user)return;
      choice='';
      await Promise.all([load(),loadWallet()]);
      if(getPage()==='wallet-refunds' && owner()===user)announce(label(result.state),result.state==='FAILED');
    }catch(e){
      if(owner()!==user)return;
      await load();
      if(getPage()==='wallet-refunds' && owner()===user)announce(e.code?describe(e):tr('Check the refund history before retrying.','请先刷新退款记录，确认这笔退款的状态。'),true);
    }
  }
  return {enter,load,select,screen,submit,label};
}
