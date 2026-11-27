'use strict';

function stationExperience({tr,esc,render,getAccount,onLinked}) {
  let owner='', cards=[], preview=false, plugged='', session='', timer, sheet;
  const key=g=>g && JSON.stringify([g.country_code,g.party_id,g.location_id,g.evse_uid,g.connector_id]);
  function leave() {
    clearTimeout(timer); preview=false; plugged=''; session='';
    if(sheet?.open) sheet.close();
  }
  function syncOwner() {
    const current=getAccount().owner();
    if(current!==owner){leave();cards=[];owner=current;}
  }
  function connected(gun) {return !!gun && (preview ? plugged===key(gun) : gun.vehicle_connection==='CONNECTED');}
  function usable(gun) {return !!gun && gun.standard==='IEC_62196_T2_COMBO' && ['AVAILABLE','PREPARING'].includes(gun.status);}
  function plugReport(gun) {
    if (!gun?.reportsPlugOnReserved || gun.status!=='RESERVED') return '';
    if (gun.vehicle_connection==='DISCONNECTED') return tr('Cable disconnected','未插枪');
    if (gun.vehicle_connection==='CONNECTED') return tr('Vehicle connected','已连接车辆');
    return tr('Plug-in to verify','插枪待核验');
  }
  function banner(gun,{loading=false,refreshed=false,recheck=false,pilot=false}={}) {
    if(!gun)return '';
    const ok=connected(gun), busy=!usable(gun);
    const reserved=gun.status==='RESERVED', inUse=gun.status==='CHARGING';
    const report=plugReport(gun);
    const message=report || (pilot && !ok ? tr('Ready for a test start request','已可申请试充') :
      reserved ? tr('Station reports a reservation','桩端上报此枪已预约') :
      inUse ? tr('This connector is charging','此枪正在充电') :
      busy ? tr('Connector unavailable','此枪暂不可用') :
      ok ? tr('✓ Vehicle connected','✓ 已连接车辆') :
      gun.vehicle_connection==='DISCONNECTED' || preview ? tr('Connect the charging cable','请连接充电枪') :
      tr('Waiting for plug confirmation','等待桩端确认插枪'));
    let detail='';
    if(report)detail=gun.vehicle_connection==='DISCONNECTED'
      ? tr('Check that the selected cable is plugged into your vehicle.','请检查所选枪口是否已插入你的车辆。')
      : tr('This station reports this status when a cable is plugged in. AFE checks access to the selected connector before starting.',
        '这台桩在插枪时会上报此状态。启动前，AFE 会核对你能否使用这把枪。');
    else if(pilot)detail=tr('Plug the selected cable into your vehicle and press Start.','请把所选充电枪插入你的车辆，再点「开始充电」。');
    else if(reserved)detail=tr('We could not confirm a reservation for your account. You can refresh this connector or choose another available one.',
      '尚未确认这笔预约属于你的账户。可刷新此枪状态，或选择现场空闲的另一把枪。');
    else if(inUse)detail=tr('If you started this session in AFE, open Orders to check it.','如果是你通过 AFE 启动的充电，可到「订单」查看。');
    else if(gun.status==='UNKNOWN')detail=tr('The station has not confirmed this connector’s status.','暂未取得桩端状态，可重新查询。');
    else if(!busy && !ok)detail=tr('Plug in the selected cable. If already connected, leave it in place and refresh the status.',
      '请插好所选枪口。若已插枪，请保持连接并刷新状态。');
    if(refreshed && !loading && !preview)detail+=(detail?' ':'')+tr('Status checked.','已重新查询。');
    const panelState=report ? (gun.vehicle_connection==='CONNECTED'?'connected':'waiting') :
      busy ? 'busy' : ok ? 'connected' : 'waiting';
    return '<div class="plug-panel" role="status" data-plug-state="'+panelState+'"><strong>'+message+'</strong>'+
      (preview ? '<small>'+tr('Charging preview','充电体验')+'</small>'+
        (!busy && !session?'<button type="button" data-act="toggle-plug">'+(ok?tr('Simulate unplugging','模拟拔枪'):tr('Simulate plugging in','模拟插枪'))+'</button>':'') :
        (detail?'<small>'+detail+'</small>':'')+
        ((busy || !ok) && !recheck && !pilot ? '<button type="button" data-act="refresh-gun"'+(loading?' disabled':'')+'>'+
          tr(loading?'Checking…':'Refresh connector status',loading?'正在查询…':'刷新枪口状态')+'</button>' : ''))+'</div>';
  }
  function closeSheet(){if(sheet?.open)sheet.close();}
  function showBinding(demo) {
    if(sheet?.open)return;
    const dialog=document.createElement('dialog');sheet=dialog;
    dialog.className='bind-sheet';dialog.setAttribute('aria-labelledby','bind-heading');
    const title=demo?tr('Link a demo card','绑定体验卡'):tr('Link a bank card','绑定银行卡');
    const input=(label,attr)=>'<label class="sheet-field">'+label+'<input '+attr+' autocomplete="off" required></label>';
    dialog.innerHTML='<div class="sheet-handle"></div><div class="sheet-heading"><h2 id="bind-heading">'+title+'</h2>'+
      '<button type="button" data-close aria-label="'+tr('Close','关闭')+'">×</button></div>'+
      (demo?'<p>'+tr('Use test card details. This preview stays on this device.','请使用测试卡资料，操作仅在本机演示。')+'</p>'+
        '<form data-demo-bind autocomplete="off" novalidate>'+input(tr('Card number','卡号'),'data-pan inputmode="numeric" maxlength="23" placeholder="4242 4242 4242 4242"')+
        '<div class="sheet-row">'+input(tr('Expiry date','有效期'),'data-exp inputmode="numeric" maxlength="7" placeholder="MM/YY"')+
        input('CVV','data-cvv type="password" inputmode="numeric" maxlength="4" placeholder="•••"')+'</div>'+
        '<button type="button" data-sample class="text-action">'+tr('Fill in test card','填入测试卡')+'</button>'+
        '<p class="sheet-error" role="alert"></p><button class="station-primary" type="submit">'+tr('Link demo card','确认绑定体验卡')+'</button></form>' :
        getAccount().cardBinding());
    const opener=document.activeElement;
    document.body.append(dialog);
    const form=dialog.querySelector('[data-demo-bind]');
    function dismiss(){dialog.close();}
    dialog.querySelector('[data-close]').onclick=dismiss;
    dialog.addEventListener('click',e=>{if(e.target===dialog){const b=dialog.getBoundingClientRect();if(e.clientY<b.top||e.clientY>b.bottom||e.clientX<b.left||e.clientX>b.right)dismiss();}});
    dialog.addEventListener('close',()=>{form?.reset();dialog.remove();if(sheet===dialog)sheet=null;
      if(opener?.isConnected)opener.focus({preventScroll:true});else document.querySelector('[data-charge-card]')?.focus({preventScroll:true});},{once:true});
    if(!demo)dialog.addEventListener('submit',e=>void getAccount().submit(e));
    if(form){
      const pan=form.querySelector('[data-pan]'),exp=form.querySelector('[data-exp]'),cvv=form.querySelector('[data-cvv]');
      const message=form.querySelector('.sheet-error');
      function clearError(){message.textContent='';form.querySelector('[aria-invalid]')?.removeAttribute('aria-invalid');}
      form.addEventListener('input',clearError);
      exp.oninput=()=>{const v=exp.value.replace(/\D/g,'').slice(0,4);exp.value=v.length>2?v.slice(0,2)+'/'+v.slice(2):v;};
      form.querySelector('[data-sample]').onclick=()=>{pan.value='4242 4242 4242 4242';exp.value='12/'+String(new Date().getFullYear()+2).slice(-2);cvv.value='123';clearError();};
      form.onsubmit=e=>{
        e.preventDefault();
        const digits=pan.value.replace(/[ -]/g,'');
        let sum=0;for(let i=digits.length-1,n=0;i>=0;i--,n++){let d=Number(digits[i]);if(n%2){d*=2;if(d>9)d-=9;}sum+=d;}
        const parts=/^(0[1-9]|1[0-2])\/(\d{2})$/.exec(exp.value.trim());
        const invalid=!/^\d{13,19}$/.test(digits)||!sum||sum%10!==0 ? [pan,tr('Enter a valid test card number.','请输入有效的测试卡号。')] :
          !parts||new Date(2000+Number(parts[2]),Number(parts[1]),1)<=new Date() ? [exp,tr('Enter a current expiry in MM/YY format.','请输入尚未到期的月/年。')] :
          !/^\d{3,4}$/.test(cvv.value) ? [cvv,tr('Enter a 3 or 4 digit CVV.','请输入 3 或 4 位 CVV。')] : null;
        if(invalid){message.textContent=invalid[1];invalid[0].setAttribute('aria-invalid','true');invalid[0].focus();return;}
        const masked={id:'demo-'+crypto.randomUUID(),last4:digits.slice(-4),brand:tr('Demo card','体验卡')};
        form.reset();cards.push(masked);preview=true;onLinked(masked.id);dismiss();render();
      };
    }
    dialog.showModal();
  }
  function startDemo(gun){
    if(!preview || !usable(gun) || !connected(gun) || session)return;
    session='starting';render();timer=setTimeout(()=>{session='active';render();},850);
  }
  return {syncOwner,connected,usable,plugReport,banner,showBinding,closeSheet,leave,startDemo,
    cards:()=>cards,preview:()=>preview,session:()=>session,
    enable(){preview=true;}, toggle(gun){if(preview && usable(gun) && !session)plugged=connected(gun)?'':key(gun);},
    finish(){clearTimeout(timer);session='';plugged='';}};
}
