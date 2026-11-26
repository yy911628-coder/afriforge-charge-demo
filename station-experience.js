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
  function banner(gun) {
    if(!gun)return '';
    const ok=connected(gun), busy=!usable(gun);
    const message=busy ? (gun.status==='CHARGING'?tr('Connector in use','此枪正在充电'):tr('Connector unavailable','此枪暂不可用')) :
      ok?tr('✓ Vehicle connected','✓ 已连接车辆'):tr('Connect the charging cable','请连接充电枪');
    return '<div class="plug-panel" role="status" data-plug-state="'+(busy?'busy':ok?'connected':'waiting')+'"><strong>'+message+'</strong>'+
      (preview ? '<small>'+tr('Charging preview','充电体验')+'</small>'+
        (!busy && !session?'<button type="button" data-act="toggle-plug">'+(ok?tr('Simulate unplugging','模拟拔枪'):tr('Simulate plugging in','模拟插枪'))+'</button>':'') :
        !busy && !ok ? '<small>'+tr('Waiting for confirmation from the charger','等待充电桩确认连接')+'</small>':'')+'</div>';
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
  return {syncOwner,connected,usable,banner,showBinding,closeSheet,leave,startDemo,
    cards:()=>cards,preview:()=>preview,session:()=>session,
    enable(){preview=true;}, toggle(gun){if(preview && usable(gun) && !session)plugged=connected(gun)?'':key(gun);},
    finish(){clearTimeout(timer);session='';plugged='';}};
}
