'use strict';

function driverAccount({root,tr,esc,navigate,render,getPage,getPayments}) {
  const protectedPages=new Set(['profile','profile-edit','vehicles','vehicle-new','security','email-verify','password','delete','settings','wallet','orders','notifications']);
  const publicPages=new Set(['login','register','forgot','reset']);
  let profile=null,orders=[],ordersState='',willVisit='',emailHint='',notice='',working=false,ordersLoad=0;
  let wallet=null,walletState='',walletRequest=0;
  const money=cents=>'R'+(cents/100).toFixed(2);
  const topupKey=()=> 'afe.wallet.topup.'+AFE_BASE_URL+'.'+profile.user.uid;
  let validating=!!AFEAuth.token();
  const codeKey='afe.email-verification.v2.'+AFE_BASE_URL;
  let mailStatus='loading',statusRequest=0,resendTimer;
  function pendingCode(purpose) {
    try {
      const value=JSON.parse(sessionStorage.getItem(codeKey));
      if(value?.expiresAt>Date.now() && value.purpose===purpose && value.owner===(purpose==='existing'?profile?.user.uid:null))return value;
    } catch {}
    return null;
  }
  const entry=new URL(location.href), resetParams=new URLSearchParams(entry.hash.slice(1));
  let resetCode=resetParams.get('reset');
  if(resetCode){entry.hash='';history.replaceState(null,'',entry.pathname+entry.search);}
  window.addEventListener('hashchange',()=>{
    const url=new URL(location.href),code=new URLSearchParams(url.hash.slice(1)).get('reset');
    if(!code)return;
    resetCode=code;url.hash='';history.replaceState(null,'',url.pathname+url.search);navigate('reset',false);
  });
  const requested=entry.searchParams.get('account');
  let initial=resetCode?'reset':['delete','login','wallet','register','forgot'].includes(requested)?requested:null;
  if(requested==='wallet' && entry.searchParams.has('card_link')){
    notice=entry.searchParams.get('card_link')==='verified'?tr('Card linked.','银行卡已绑定。'):tr('Card verification was not completed. You can try again.','银行卡验证未完成，可以重新绑定。');
    entry.searchParams.delete('card_link');
  }
  if(requested){entry.searchParams.delete('account');history.replaceState(null,'',entry.pathname+entry.search+entry.hash);}
  const api=(path,method,body)=>AFEApi.account(path,method,body);
  const button=(page,en,zh)=>'<button type="button" class="acct-row" data-page="'+page+'">'+tr(en,zh)+'<span aria-hidden="true">›</span></button>';
  const action=(op,text,id='')=>'<button type="button" class="rec-refresh" data-account="'+op+'" data-id="'+esc(id)+'">'+text+'</button>';
  const field=(name,label,type='text',attrs='',value='')=>'<label class="acct-field">'+label+'<input class="app-input" name="'+name+'" type="'+type+'" '+attrs+' value="'+esc(value)+'"></label>';
  const form=(name,contents,submit)=>'<form class="acct-form" data-account-form="'+name+'">'+contents+
    '<button class="acct-primary" type="submit">'+submit+'</button></form>';
  const feedback=()=>'<p class="acct-message" role="status" data-account-message>'+esc(notice)+'</p>';
  const back=(page,label)=>'<button type="button" class="app-back" data-page="'+page+'"><span aria-hidden="true">‹</span> '+label+'</button>';
  const title=label=>'<h1>'+label+'</h1>';
  const card=html=>'<section class="app-card rec-card">'+html+'</section>';
  const pwHint=()=>tr('Use at least 8 characters, including a letter and a number.','至少 8 位，包含字母和数字。');
  const email=()=>field('email',tr('Email address','邮箱地址'),'email','autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" maxlength="254" placeholder="name@example.com" required',emailHint);
  const pw=(name,label,fresh)=>field(name,label,'password','autocomplete="'+(fresh?'new-password':'current-password')+'" '+(fresh?'minlength="8" ':'')+'maxlength="256" required');
  const newPw=()=>pw('password',tr('New password','新密码'),true)+'<small>'+pwHint()+'</small>'+pw('confirm',tr('Confirm password','确认密码'),true);
  const legal=(section,en,zh)=>'<a href="./legal.html?lang='+(tr('en','zh'))+'#'+section+'" data-legal="true">'+tr(en,zh)+'</a>';
  function target(page) {
    if(protectedPages.has(page) && !profile){willVisit=page;return validating?'account-loading':'login';}
    return page;
  }
  function announce(message,bad=false) {
    notice=message;
    const node=root.querySelector('[data-account-message]');
    if(node){node.textContent=message;node.setAttribute('role',bad?'alert':'status');}
  }
  function describe(e){
    const errors={
      WALLET_SETTLEMENT_BEFORE_DELETION:['Settle outstanding charging or top-ups and arrange a refund of any remaining wallet credit before deletion.','请先结清充电或充值交易，有剩余余额时请联系运营方退款后再注销。'],
      WALLET_TOPUP_PENDING:['You already have a pending top-up. Check it below.','已有一笔待确认充值，请查看该笔付款。'],
      TOPUP_STATUS_UNCONFIRMED:['Peach has not confirmed the payment yet. You can check again.','Peach 尚未确认这笔付款，可稍后刷新。'],
      TOPUP_DELIVERY_UNCONFIRMED:['Check your pending top-up before paying again.','请先查看待确认的充值记录。'],
      CARD_IN_USE:['This card is used by a session awaiting settlement.','此卡有一笔充电订单正在结算，结清后可解绑。'],
      CARD_DIRECT_NOT_CONFIGURED:['Peach card payments are awaiting activation.','Peach 正式绑卡扣款待开通。'],
      WALLET_TOPUP_NOT_CONFIGURED:['Peach top-ups are not available yet.','Peach 正式充值尚未开通。'],
      INVALID_WALLET_AMOUNT:['Enter a positive rand amount with up to two decimals.','请输入大于零的兰特金额，最多两位小数。'],
      INVALID_LOGIN:['Email or password is incorrect.','邮箱或密码不正确。'],PASSWORD_INCORRECT:['Check your current password.','当前密码不正确。'],
      INVALID_PASSWORD:['Use at least 8 characters with letters and numbers.','密码至少 8 位，并包含字母和数字。'],
      INVALID_EMAIL:['Enter a valid email address.','请输入有效邮箱。'],PASSWORD_CONFIRM:['The passwords must match.','两次输入的密码需一致。'],
      CONSENT_REQUIRED:['Read and accept both policies to register.','注册前请阅读并同意两份协议。'],
      REGISTRATION_EMAIL_NOT_CONFIGURED:['Email verification is not available yet.','邮箱验证服务尚未开通。'],
      EMAIL_CODE_REQUIRED:['Enter the six-digit code sent to your email.','请输入邮件中的六位验证码。'],
      INVALID_EMAIL_CODE:['Check the six digits in your latest email. If the code has expired, request another.','请核对最新邮件里的六位数字。验证码过期后可重新获取。'],
      VERIFICATION_COOLDOWN:['Wait one minute before requesting another code.','请等一分钟再重新获取验证码。'],
      EMAIL_CODE_LOCKED:['Three incorrect codes. Try again in 10 minutes.','连续三次验证码错误，请在 10 分钟后重试。'],
      INVALID_REGISTER_TOKEN:['Email verification has expired. Request a new code.','本次邮箱验证已过期，请重新获取验证码。'],
      CLIENT_UPDATE_REQUIRED:['Refresh the app to continue.','请刷新应用后继续。'],
      EMAIL_ALREADY_VERIFIED:['This email has already been verified.','此邮箱已完成验证。'],
      REGISTRATION_UNAVAILABLE:['This email cannot be registered. Try signing in.','该邮箱无法再次注册，请尝试登录。'],
      INVALID_SA_PHONE:['Enter a South African mobile number, such as 082 000 0000.','请输入南非手机号，例如 082 000 0000。'],
      INVALID_VIN:['A VIN has 17 letters and numbers and excludes I, O and Q.','VIN 为 17 位，不含 I、O、Q。'],
      INVALID_RESET:['The reset link has expired or was used. Request another email.','链接已过期或已使用，请重新申请。'],
      RESET_EMAIL_NOT_CONFIGURED:['Password recovery email is not available yet.','密码重置邮件服务尚未开通。'],
      EMAIL_DELIVERY_UNAVAILABLE:['We could not confirm that your email was sent. Please try again shortly.','暂时无法确认邮件已发出，请稍后再试。'],
      END_CHARGE_BEFORE_DELETION:['Finish your charging session and refresh its status before deleting the account.','请先结束充电并刷新订单状态，再注销账户。'],
      TRY_LATER:['Too many attempts. Please try again later.','操作次数过多，请稍后再试。'],
      ACCOUNT_DATABASE_NOT_FOUND:['The account database is being set up. Please try again later.','账户数据库正在配置，请稍后重试。'],
      ACCOUNT_DATABASE_PERMISSION_DENIED:['The account service is waiting for database access. Please try again later.','账户服务正在等待数据库授权，请稍后重试。'],
      ACCOUNT_SERVICE_UNAVAILABLE:['The account service is temporarily unavailable. Please try again.','账户服务暂时无法连接，请重试。'],
      DELETION_PENDING:['Deletion is in progress. Re-enter your password to finish.','账户正在删除，请重新输入密码以完成注销。']};
    return errors[e.code]?tr(...errors[e.code]):tr('The request did not complete. Try again.','请求未完成，请重试。');
  }
  let notifications=[],notificationOwner='',notifying=false,notificationError=false;
  function notificationText(n){
    const amount=money(n.costCents || 0).replace(/^R\s*/,'');
    switch(n.kind){
      case 'STARTED':return tr('[AFE Charge] Your vehicle has started charging.','【AFE Charge】您的车辆已开始充电。');
      case 'CARD_PAID':return tr('[AFE Charge] Charging ended. Your card ending '+n.last4+' was charged R '+amount+'.','【AFE Charge】充电结束，已从您尾号 '+n.last4+' 的银行卡扣款 R '+amount+'。');
      case 'WALLET_SETTLED':return n.shortfallCents?tr('[AFE Charge] Charging ended. Wallet payment applied. Outstanding: '+money(n.shortfallCents)+'.','【AFE Charge】充电结束，钱包已抵扣，剩余待补 '+money(n.shortfallCents)+'。'):
        tr('[AFE Charge] Charging ended. Your wallet was charged R '+amount+'.','【AFE Charge】充电结束，已从钱包扣款 R '+amount+'。');
      case 'CARD_DECLINED':return tr('[AFE Charge] Card payment declined. Outstanding: R '+amount+'.','【AFE Charge】银行卡扣款失败，待支付 R '+amount+'。');
      case 'NO_CHARGE':return tr('[AFE Charge] Charging ended. The final bill is R0.00.','【AFE Charge】充电结束，本次应付 R0.00。');
      default:return '';
    }
  }
  function toast(items){
    const message=document.createElement('aside');message.className='charge-toast';message.setAttribute('role','status');
    message.textContent=items.map(notificationText).join('\n');document.body.append(message);setTimeout(()=>message.remove(),6500);
  }
  async function loadNotifications(){
    const uid=profile?.user?.uid;if(!uid || notifying || document.hidden)return;
    notifying=true;
    try{
      const {notifications:items}=await api('/me/notifications');
      if(profile?.user.uid!==uid || !Array.isArray(items))return;
      const key='afe.notifications.'+AFE_BASE_URL+'.'+uid;
      let seen;try{seen=JSON.parse(localStorage.getItem(key));}catch{}
      const fresh=Array.isArray(seen)?items.filter(x=>!seen.includes(x.id)).reverse():[];
      if(fresh.length)toast(fresh);
      localStorage.setItem(key,JSON.stringify(items.map(x=>x.id)));
      notifications=items;notificationOwner=uid;notificationError=false;
    }catch{notificationError=true;}finally{notifying=false;if(getPage()==='notifications')render();}
  }
  setInterval(loadNotifications,12000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void loadNotifications();});
  window.addEventListener('afe-charge-update',()=>void loadNotifications());
  async function refresh(){profile=await api('/me');void loadNotifications();return profile;}
  async function loadOrders(){
    const n=++ordersLoad;ordersState='loading';render();
    try{const value=await api('/me/orders');if(n!==ordersLoad)return;orders=value.orders;ordersState='ready';}
    catch{if(n===ordersLoad)ordersState='error';}
    finally{if(n===ordersLoad && getPage()==='orders')render();}
  }
  async function loadWallet(){
    const uid=profile?.user.uid,n=++walletRequest;
    if(!uid)return;
    walletState='loading';
    try{
      const value=await api('/me/wallet');
      if(profile?.user.uid!==uid || n!==walletRequest)return;
      if(value.currency!=='ZAR' || ![value.balanceCents,value.dueCents,value.minimumCents].every(x=>Number.isSafeInteger(x) && x>=0) ||
        !Array.isArray(value.entries))throw new Error('Invalid wallet');
      wallet=value;walletState='ready';
    }catch{if(n===walletRequest){wallet=null;walletState='error';}}
    finally{if(n===walletRequest && ['wallet','station'].includes(getPage()))render();}
  }
  function walletPanel(){
    if(!wallet)return card('<h2>'+tr('Available balance','可用余额')+'</h2>'+(walletState==='error'?
      action('reload-wallet',tr('Retry loading balance','重新读取余额')):'<p>'+tr('Loading balance…','正在读取余额…')+'</p>'));
    const pending=wallet.pendingTopup;
    let main='<h2>'+tr('Available balance','可用余额')+'</h2><p class="wallet-balance">'+money(wallet.balanceCents)+'</p>';
    if(wallet.dueCents)main+='<p class="rec-alert">'+tr('Outstanding charging cost','待补充电费')+' · '+money(wallet.dueCents)+'</p>';
    main+='<p>'+tr('To start charging, your balance must be above ','启动充电时，钱包余额须大于 ')+money(wallet.minimumCents)+tr('.','。')+'</p>';
    if(pending){
      main+='<p>'+tr('Pending top-up','待确认充值')+' · R'+esc(pending.amount)+'</p>'+action('check-topup',tr('Check payment','查询付款结果'),pending.id);
      if(pending.redirect_url)main+=action('continue-topup',tr('Continue to Peach','继续前往 Peach'));
    }else if(wallet.topupEnabled)main+=form('topup',field('amount',tr('Top-up amount (ZAR)','充值金额（兰特）'),'number','min="0.01" max="99999999.99" step="0.01" inputmode="decimal" required'),tr('Top up with Peach','使用 Peach 充值'));
    else main+='<p>'+tr('Top-ups will open when Peach activates live payments.','Peach 正式支付开通后即可充值。')+'</p>';
    main+=action('reload-wallet',tr('Refresh balance','刷新余额'));
    const rows=wallet.entries.map(item=>'<article class="acct-item"><strong>'+tr(...(item.kind==='TOPUP'?['Top-up','钱包充值']:['Charging','充电消费']))+
      ' · '+(item.deltaCents>=0?'+':'−')+money(Math.abs(item.deltaCents))+'</strong><p>'+esc(new Date(item.createdAt).toLocaleString())+
      (item.shortfallCents?' · '+tr('Shortfall','本单差额')+' '+money(item.shortfallCents):'')+
      (item.repaidCents?' · '+tr('Applied to outstanding cost','已抵扣欠费')+' '+money(item.repaidCents):'')+'</p></article>').join('');
    return card(main)+card('<h2>'+tr('Wallet activity','钱包流水')+'</h2>'+(rows || '<p>'+tr('No transactions yet.','暂无交易记录。')+'</p>'));
  }
  function openTopup(url){
    let dest;
    try{dest=new URL(url);}catch{}
    const local=location.hostname==='127.0.0.1' && dest?.origin===location.origin && dest.pathname==='/local/topup';
    if((!local && dest?.origin!=='https://secure.peachpayments.com') || dest.username || dest.password || dest.hash)throw new ChargeApiError(502,'INVALID_CHECKOUT_URL');
    location.assign(dest.href);
  }
  async function checkMail(){
    const request=++statusRequest;
    mailStatus='loading';
    try {
      const result=await api('/auth/registration-status');
      if(request===statusRequest)mailStatus=result.emailVerificationAvailable?'ready':'off';
    } catch {if(request===statusRequest)mailStatus='error';}
    if(request===statusRequest && ['register','email-verify','forgot'].includes(getPage()))render();
  }
  function enter(page){
    notice='';
    clearTimeout(resendTimer);
    if(['wallet','station'].includes(page) && profile)void loadWallet();
    if(page==='notifications' && profile)void loadNotifications();
    if(page==='orders' && profile)void loadOrders();
    if(['register','email-verify','forgot'].includes(page))void checkMail();
  }
  function purposeForPage(){
    return getPage()==='email-verify'?'existing':getPage()==='forgot'?'reset':'register';
  }
  async function sendCode(address,purpose){
    const page=getPage();
    const path={existing:'/me/email/code',register:'/auth/send-code',reset:'/auth/forgot-password'}[purpose];
    const data=await api(path,'POST',purpose==='existing'?{}:{email:address});
    if(page!==getPage())return;
    emailHint=address.trim().toLowerCase();
    sessionStorage.setItem(codeKey,JSON.stringify({email:address.trim().toLowerCase(),purpose,
      owner:purpose==='existing'?profile.user.uid:null,expiresAt:Date.now()+data.expiresIn*1000,resendAt:Date.now()+data.retryAfter*1000}));
    notice='';render();root.querySelector('input[autocomplete="one-time-code"]')?.focus();
  }
  function mailProgress(labels,step){
    return '<ol class="mail-progress" aria-label="'+tr('Verification steps','邮箱验证步骤')+'">'+labels.map((label,i)=>
      '<li'+(i===step?' aria-current="step"':'')+' class="'+(i<=step?'reached':'')+'">'+label+'</li>').join('')+'</ol>';
  }
  function updateMailTimer(purpose,pending){
    clearTimeout(resendTimer);
    const panel=root.querySelector('[data-mail-stage]');
    if(!panel || panel.dataset.mailStage!==purpose)return;
    const now=Date.now();
    if(now>=pending.expiresAt){
      emailHint=pending.email;notice=tr('Your verification expired. Request a new code.','本次验证已过期，请重新获取验证码。');render();return;
    }
    const lock=Math.max(0,Math.ceil(((pending.lockedUntil || 0)-now)/1000));
    const remaining=Math.max(lock,0,Math.ceil((pending.resendAt-now)/1000));
    const resend=panel.querySelector('[data-account="resend-code"]');
    if(resend){
      resend.disabled=remaining>0;
      resend.textContent=remaining?tr('Resend in '+remaining+'s',remaining+' 秒后可重发'):tr('Resend code','重新发送验证码');
      if(!working)panel.querySelector('button[type="submit"]').disabled=lock>0;
    }
    resendTimer=setTimeout(()=>updateMailTimer(purpose,pending),remaining?1000:Math.max(1,pending.expiresAt-now));
  }
  function mailError(error,purpose){
    const pending=pendingCode(purpose);
    const wait=error.retryAfter;
    if(!wait || !['EMAIL_CODE_LOCKED','VERIFICATION_COOLDOWN'].includes(error.code))return describe(error);
    if(pending){
      pending.resendAt=Date.now()+wait*1000;
      if(error.code==='EMAIL_CODE_LOCKED')pending.lockedUntil=pending.resendAt;
      sessionStorage.setItem(codeKey,JSON.stringify(pending));
      updateMailTimer(purpose,pending);
    }
    return error.code==='EMAIL_CODE_LOCKED'
      ?tr('Too many incorrect codes. Try again in '+Math.ceil(wait/60)+' min.','连续输错验证码，请在 '+Math.ceil(wait/60)+' 分钟后再试。')
      :tr('Please wait '+wait+'s before requesting another code.','请在 '+wait+' 秒后重新获取验证码。');
  }
  root.addEventListener('paste',event=>{
    const input=event.target;
    if(!input.matches('input[autocomplete="one-time-code"]'))return;
    const pasted=event.clipboardData?.getData('text') || '';
    const digits=pasted.replace(/[\s-]/g,'');
    if(/^\d{6}$/.test(digits)){event.preventDefault();input.value=digits;input.dispatchEvent(new Event('input',{bubbles:true}));}
  });
  function verificationScreen(purpose){
    clearTimeout(resendTimer);
    const existing=purpose==='existing',reset=purpose==='reset';
    const heading=existing?tr('Verify email','验证邮箱'):reset?tr('Forgot password','忘记密码'):tr('Create an account','注册账户');
    const head=back(existing?'security':'login',existing?tr('Account security','账户安全'):tr('Sign in','登录'))+title(heading);
    const pending=pendingCode(purpose);
    const steps=[tr('Email','邮箱'),reset?tr('New password','重置密码'):tr('Code','验证码')];
    if(!existing && !reset)steps.push(tr('Password','设置密码'));
    const shell=(content,step=0)=>head+'<section class="app-card rec-card mail-panel" data-mail-stage="'+purpose+'">'+
      mailProgress(steps,step)+content+'</section>';
    if(!pending && mailStatus!=='ready'){
      if(mailStatus==='loading')return shell('<p role="status">'+tr('Checking email service…','正在连接邮箱验证服务…')+'</p>');
      const reason=mailStatus==='error'?tr('Could not reach the account service. Check your connection and try again.','暂时无法连接账户服务，请检查网络后重试。'):
        tr('Verification emails are awaiting activation. Existing drivers can still sign in with their password.','验证码邮件服务待开通，已有账户可继续使用密码登录。');
      return shell('<p role="status">'+reason+'</p>'+action('retry-mail',tr('Check again','重新检查')));
    }
    if(!pending){
      const instruction=reset?tr('Enter the email used for your AFE Charge account.','请输入注册 AFE Charge 时使用的邮箱。'):
        tr('We’ll send a six-digit code to this address.','我们会向这个邮箱发送六位验证码。');
      return shell('<h2>'+tr('Your email address','你的邮箱')+'</h2><p>'+instruction+'</p>'+
        form('send-code',existing?'<p class="mail-address">'+esc(profile.user.email)+'</p>':email(),reset?tr('Send reset code','发送重置验证码'):tr('Send verification code','发送验证码'))+feedback());
    }
    resendTimer=setTimeout(()=>updateMailTimer(purpose,pending),0);
    const address='<strong class="mail-address">'+esc(pending.email)+'</strong>';
    if(pending.registerToken){
      const consent='<label class="acct-check"><input type="checkbox" name="consent" required><span>'+tr('I agree to the ','我已阅读并同意')+
        legal('privacy','Privacy Policy','《隐私政策》')+tr(' and ','和')+legal('terms','Terms of Service','《服务条款》')+'</span></label>';
      return shell('<h2>'+tr('Set your password','设置登录密码')+'</h2><p class="mail-verified">'+tr('Verified email','已验证邮箱')+'<br>'+address+'</p>'+
        form('register',newPw()+consent,tr('Create account','创建账户'))+feedback(),2);
    }
    const code=field('code',tr('Six-digit code','六位验证码'),'text','inputmode="numeric" autocomplete="one-time-code" dir="ltr" spellcheck="false" aria-describedby="mail-code-hint" pattern="[0-9]{6}" maxlength="6" required');
    const instruction=reset?tr('If an account exists, check this inbox for your reset code.','如果该邮箱已注册，请在收件箱查找重置验证码。'):
      tr('Check this inbox for the latest code.','请在以下邮箱查收最新验证码。');
    const content=reset?form('reset',code+newPw(),tr('Reset password','重置密码')):form(existing?'verify-email':'verify-code',code,tr('Verify email','验证邮箱'));
    return shell('<h2>'+tr('Check your email','查收验证码')+'</h2><p>'+instruction+'<br>'+address+'</p><p id="mail-code-hint">'+
      tr('Valid for 15 minutes. If needed, check your spam folder.','验证码 15 分钟内有效。找不到邮件时，可查看垃圾邮件。')+'</p>'+
      content+feedback()+'<div class="mail-actions"><button data-account="resend-code" type="button" class="rec-refresh" disabled>'+tr('Resend code','重新发送验证码')+'</button>'+
      (existing?'':action('change-email',tr('Change email','更换邮箱')))+'</div>',1);
  }
  function authScreen(page){
    if(page==='login')return title(tr('Sign in','登录'))+card(form('login',email()+pw('password',tr('Password','密码'),false)+
      '<label class="acct-check"><input type="checkbox" name="remember"> '+tr('Remember me on this device','在此设备记住我')+'</label>',tr('Sign in','登录'))+
      feedback()+button('forgot','Forgot password?','忘记密码？')+button('register','Create an account','注册新账户'));
    if(page==='register')return verificationScreen('register');
    if(page==='forgot')return verificationScreen('reset');
    return back('forgot',tr('Request a new link','重新申请链接'))+title(tr('Set a new password','重置密码'))+
      card(form('reset',newPw(),tr('Reset password','重置密码'))+feedback());
  }
  function screen(page){
    if(page==='account-loading')return card('<p role="status">'+tr('Checking your sign-in…','正在验证登录状态…')+'</p>');
    if(publicPages.has(page))return authScreen(page);
    if(!profile)return '';
    const {user,vehicles,cards}=profile;
    if(page==='profile'){
      const name=user.name || user.email.split('@')[0];
      return title(tr('Profile','我的'))+card('<div class="acct-person"><div class="acct-avatar" aria-hidden="true">'+esc(Array.from(name)[0]?.toUpperCase())+
        '</div><div><h2>'+esc(name)+'</h2><p>'+esc(user.email)+'</p></div></div>'+
        button('profile-edit','Edit profile','编辑个人资料')+button('vehicles','My vehicles','车辆管理')+
        button('wallet','Wallet and cards','钱包与银行卡')+button('notifications','Notifications','通知中心')+button('security','Account security','账户安全')+button('settings','Settings and legal','设置与法律信息'))+
        card(action('logout',tr('Sign out','退出登录'))+feedback());
    }
    const toProfile=back('profile',tr('Profile','我的'));
    if(page==='profile-edit')return toProfile+title(tr('Edit profile','编辑个人资料'))+card(form('profile',
      field('name',tr('Name','姓名'),'text','autocomplete="name" maxlength="100"',user.name)+
      field('phone',tr('South African mobile','南非手机号'),'tel','autocomplete="tel" maxlength="30" placeholder="082 000 0000"',user.phone)+
      field('email',tr('Email','邮箱'),'email','readonly',user.email)+
      '<label class="acct-field">'+tr('Account type','账户类型')+'<select name="accountType" class="app-select"><option value="personal">'+tr('Personal','个人')+
      '</option><option value="fleet" '+(user.accountType==='fleet'?'selected':'')+'>'+tr('Fleet','车队')+'</option></select></label>',tr('Save changes','保存资料'))+feedback());
    if(page==='vehicles')return toProfile+title(tr('My vehicles','车辆管理'))+card((vehicles.length?vehicles.map(car=>
      '<article class="acct-item"><h2>'+esc(car.nickname)+(car.isDefault?' <small class="acct-badge">'+tr('Default','默认')+'</small>':'')+'</h2><p>'+
      esc([car.brand,car.model,car.plate].join(' · '))+'</p>'+(car.vin?'<p>VIN '+esc(car.vin)+'</p>':'')+
      (!car.isDefault?action('default',tr('Set as default','设为默认'),car.id):'')+action('remove-vehicle',tr('Remove','移除车辆'),car.id)+'</article>').join(''):
      '<p>'+tr('Add the vehicle you normally charge.','添加你平时充电使用的车辆。')+'</p>')+button('vehicle-new','Add a vehicle','添加车辆')+feedback());
    if(page==='vehicle-new')return back('vehicles',tr('My vehicles','车辆管理'))+title(tr('Add vehicle','添加车辆'))+
      card(form('vehicle',['nickname','brand','model','plate','vin'].map((k,i)=>field(k,
        tr(...[['Nickname','昵称'],['Make','品牌'],['Model','型号'],['Registration plate','车牌号'],['VIN (optional)','VIN（选填）']][i]),
        'text',['maxlength="50" required','maxlength="60" required','maxlength="60" required','maxlength="24" required','maxlength="17" autocapitalize="characters"'][i])).join('')+
        '<label class="acct-check"><input name="isDefault" type="checkbox" '+(!vehicles.length?'checked disabled':'')+'> '+tr('Default for charging','充电时默认选中')+'</label>',tr('Save vehicle','保存车辆'))+feedback());
    if(page==='email-verify')return verificationScreen('existing');
    if(page==='security')return toProfile+title(tr('Account security','账户安全'))+card((user.emailVerifiedAt?
      '<p>'+tr('Email verified','邮箱已验证')+'</p>':button('email-verify','Verify my email','验证我的邮箱'))+button('password','Change password','修改密码')+
      '<div class="acct-danger">'+button('delete','Delete account','注销账户')+'</div>');
    if(page==='settings')return toProfile+title(tr('Settings and legal','设置与法律信息'))+card('<div class="acct-legal">'+
      legal('privacy','Privacy Policy','隐私政策')+legal('terms','Terms of Service','服务条款')+
      legal('deletion','Account and data deletion','账户与数据删除说明')+'</div>'+button('delete','Delete account','注销账户'));
    if(page==='password')return back('security',tr('Account security','账户安全'))+title(tr('Change password','修改密码'))+
      card(form('password',pw('currentPassword',tr('Current password','当前密码'),false)+newPw(),tr('Change password and sign out','修改密码并退出'))+feedback());
    if(page==='delete')return back('security',tr('Account security','账户安全'))+title(tr('Delete account','注销账户'))+card(
      '<p>'+tr('Your sign-in, profile, vehicles, saved payment methods and personal order list will be deleted. Financial and charging records required for reconciliation or by law may be retained.',
      '注销将删除登录信息、个人资料、车辆、已保存的支付方式和个人订单列表。依法或为结算需要保留的支付和充电记录可能继续保存。')+'</p>'+
      form('delete',pw('password',tr('Confirm your password','输入当前密码'),false),tr('Delete my account','注销我的账户'))+feedback());
    if(page==='notifications'){
      const list=notificationOwner===user.uid?notifications:[];
      return toProfile+title(tr('Notifications','通知中心'))+card((list.map(n=>'<article class="acct-item"><p>'+esc(notificationText(n))+'</p><small>'+esc(new Date(n.createdAt).toLocaleString())+'</small></article>').join('') || '<p>'+tr('No charging notifications yet.','暂无充电通知。')+'</p>')+
        (notificationError?'<p>'+tr('Notifications could not be loaded.','暂时无法读取通知。')+'</p>':'')+action('reload-notifications',tr('Refresh','刷新')));
    }
    if(page==='wallet')return title(tr('Wallet','钱包'))+walletPanel()+card('<h2>'+tr('Payment methods','支付方式')+'</h2>'+
      (cards.length?cards.map(c=>'<article class="acct-item"><p>'+esc(c.brand)+' ···· '+esc(c.last4)+'</p>'+action('unlink',tr('Unlink card','解绑银行卡'),c.id)+'</article>').join(''):
      '<p>'+tr('No linked cards.','尚未绑定银行卡。')+'</p>')+
      (wallet?.cardDirectEnabled?form('bind-card','<label class="acct-check"><input type="checkbox" name="consent" required> '+tr('I authorise AFE to debit this card for the final bill of each charging session I start with it. I can unlink it after settlement.','我授权 AFE 按我选择此卡启动的每次充电最终账单扣款，结清后可解绑。')+'</label>',tr('Link a bank card','绑定银行卡')):wallet?'<p>'+tr('Peach card linking is awaiting activation.','Peach 正式绑卡待开通。')+'</p>':'')+feedback())+(getPayments().hasOrder()?getPayments().card(null):'');
    if(page==='orders')return title(tr('Orders','订单'))+(getPayments().hasOrder()?getPayments().card(null):'')+card(
      (ordersState==='loading'?'<p>'+tr('Loading orders…','正在读取订单…')+'</p>':ordersState==='error'?action('reload-orders',tr('Retry loading orders','重新加载订单')):
      orders.length?orders.map(o=>'<article class="acct-item"><h2>'+esc(o.target.location_id)+' · '+esc(o.target.connector_id)+'</h2><p>'+
      esc(new Date(o.createdAt).toLocaleString())+' · '+(['card','wallet'].includes(o.funding)?(o.funding==='card'?tr('Bank card','银行卡')+(o.last4?' ···· '+esc(o.last4):''):tr('Wallet','钱包'))+' · '+(Number.isSafeInteger(o.costCents)?money(o.costCents):o.settlement==='REJECTED'?tr('Start declined','启动被拒'):o.settlement==='NOT_STARTED'?tr('Awaiting start','待启动'):tr('Awaiting final bill','待结算'))+(o.funding==='card' && o.settlement==='SETTLED'?' · '+tr('Paid','已扣款'):o.settlement==='PAYMENT_REQUIRED'?' · '+tr('Payment due','待支付'):o.settlement==='PAYMENT_PENDING'?' · '+tr('Payment pending','扣款待确认'):'')+(o.lowBalanceStop?' · '+tr('Low-balance stop requested','已请求低余额停充'):'')+(o.shortfallCents?' · '+tr('Shortfall','本单差额')+' '+money(o.shortfallCents):''):'ZAR '+esc(o.amount))+'</p>'+action('order',tr('View order','查看订单'),o.id)+'</article>').join(''):
      '<p>'+tr('Your charging orders will appear here.','你的充电订单会显示在这里。')+'</p>')+feedback());
    return '';
  }
  function chargeControls(walletOnly=false){
    if(!profile)return button('login','Sign in to charge','登录后充电');
    if(!profile.vehicles.length){return button('vehicle-new','Add a vehicle to charge','添加充电车辆');}
    const vehicle='<label class="acct-field">'+tr('Charging vehicle','本次充电车辆')+'<select name="vehicleId" class="app-select">'+profile.vehicles.map(v=>
      '<option value="'+esc(v.id)+'" '+(v.isDefault?'selected':'')+'>'+esc(v.nickname+' · '+v.plate)+(v.isDefault?' · '+tr('Default','默认'):'')+'</option>').join('')+'</select></label>';
    if(walletOnly)return vehicle;
    return vehicle+(profile.cards.length?'<label class="acct-field">'+tr('Payment method','支付方式')+'<select name="cardId" class="app-select"><option value="">'+tr('New card','使用新卡')+'</option>'+
      profile.cards.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.brand+' ···· '+c.last4)+'</option>').join('')+'</select></label>':'')+
      '<label class="acct-check"><input type="checkbox" name="saveCard"> '+tr('Save a new card for future charging','授权保存新卡，以供下次充电使用')+'</label>';
  }
  root.addEventListener('click',event=>{
    const link=event.target.closest('a[data-legal]');
    if(!link || typeof HTMLDialogElement==='undefined')return;
    event.preventDefault();
    const dialog=document.createElement('dialog');dialog.className='acct-policy-dialog';
    const close=document.createElement('button');close.type='button';close.className='rec-refresh';close.textContent=tr('Close','关闭');
    close.onclick=()=>dialog.close();
    const frame=document.createElement('iframe');frame.src=link.href;frame.title=link.textContent;
    dialog.append(close,frame);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
  });
  async function submit(event){
    const f=event.target,op=f.dataset.accountForm;if(!op)return false;
    event.preventDefault();if(working)return true;
    const v=Object.fromEntries(new FormData(f)),btn=f.querySelector('[type="submit"]');
    if(['register','reset','password'].includes(op)){
      if(v.password!==v.confirm){announce(describe({code:'PASSWORD_CONFIRM'}),true);return true;}
      if(v.password.length<8 || !/[a-z]/i.test(v.password) || !/\d/.test(v.password)){announce(pwHint(),true);return true;}
    }
    if(op==='delete' && !confirm(tr('Permanently delete this account, vehicles and saved payment methods? This cannot be undone.',
      '确定永久删除账户、车辆和已保存的支付方式吗？此操作无法撤销。')))return true;
    working=true;btn.disabled=true;
    const label=btn.textContent;
    if(op==='send-code')btn.textContent=tr('Sending…','正在发送…');
    try {
      if(op==='bind-card'){
        if(!v.consent)return true;
        const result=await api('/me/cards/bind','POST',{consent:'afe-variable-charge-v1'}),url=new URL(result.url);
        if(url.origin!==new URL(AFE_BASE_URL).origin || url.pathname!=='/api/cards/bind/page' || !/^[\w-]{43}$/.test(url.searchParams.get('state') || ''))throw new Error('Invalid card binding address');
        location.assign(url.href);
      }else if(op==='topup'){
        const choice=Number(v.amount).toFixed(2),key=topupKey();
        let saved;try{saved=JSON.parse(sessionStorage.getItem(key));}catch{}
        if(saved?.amount!==choice){saved={amount:choice,requestId:crypto.randomUUID()};sessionStorage.setItem(key,JSON.stringify(saved));}
        try{
          const invoice=await api('/me/wallet/top-ups','POST',saved);
          sessionStorage.removeItem(key);
          if(invoice.status==='PENDING' && invoice.redirect_url)openTopup(invoice.redirect_url);
        }finally{await loadWallet();}
      }else if(op==='send-code'){
        const purpose=purposeForPage();
        await sendCode(purpose==='existing'?profile.user.email:v.email,purpose);
      } else if(op==='verify-code' || op==='verify-email'){
        const purpose=purposeForPage(),pending=pendingCode(purpose);
        if(!pending){render();announce(describe({code:'INVALID_EMAIL_CODE'}),true);return true;}
        if(op==='verify-email'){
          profile=await api('/me/email/verify','POST',{code:v.code});
          sessionStorage.removeItem(codeKey);navigate('security');
        } else {
          const result=await api('/auth/verify-code','POST',{email:pending.email,code:v.code});
          sessionStorage.setItem(codeKey,JSON.stringify({...pending,registerToken:result.registerToken,expiresAt:Date.now()+result.expiresIn*1000}));
          notice='';render();root.querySelector('input[autocomplete="new-password"]')?.focus();
        }
      } else if(op==='register'){
        const pending=pendingCode('register');
        if(!pending?.registerToken){render();announce(describe({code:'INVALID_REGISTER_TOKEN'}),true);return true;}
        const data=await api('/auth/register','POST',{email:pending.email,password:v.password,registerToken:pending.registerToken,
          termsAccepted:!!v.consent,privacyAccepted:!!v.consent,policyVersion:'2026-11-24-pilot'});
        sessionStorage.removeItem(codeKey);AFEAuth.begin(data,false);await refresh();
        const destination=willVisit || 'home';willVisit='';emailHint='';navigate(destination);
      } else if(op==='login'){
        const data=await api('/auth/login','POST',{email:v.email,password:v.password,remember:!!v.remember});
        AFEAuth.begin(data,!!v.remember);emailHint='';
        try {await refresh();} catch(e){if(e.code!=='DELETION_PENDING')throw e;profile={user:{},vehicles:[],cards:[]};willVisit='delete';}
        const destination=willVisit || 'home';willVisit='';navigate(destination);
      } else if(op==='reset' || op==='password'){
        if(op==='password')await api('/me/password','PUT',{currentPassword:v.currentPassword,password:v.password});
        else if(getPage()==='reset' && resetCode)await api('/auth/reset-password','POST',{code:resetCode,password:v.password});
        else {
          const pending=pendingCode('reset');
          if(!pending){render();announce(describe({code:'INVALID_EMAIL_CODE'}),true);return true;}
          await api('/auth/reset-password','POST',{email:pending.email,code:v.code,newPassword:v.password});
        }
        sessionStorage.removeItem(codeKey);resetCode=null;AFEAuth.end();
      } else if(op==='profile'){profile=await api('/me','PUT',{name:v.name,phone:v.phone,accountType:v.accountType});navigate('profile');}
      else if(op==='vehicle'){profile=await api('/me/vehicles','POST',{...v,isDefault:!!v.isDefault || !profile.vehicles.length});navigate('vehicles');}
      else if(op==='delete'){await api('/me','DELETE',{password:v.password,confirm:true});AFEAuth.end();}
    } catch(e){
      if(e.code==='INVALID_REGISTER_TOKEN'){sessionStorage.removeItem(codeKey);render();}
      announce(mailError(e,purposeForPage()),true);
    } finally {
      working=false;
      if(btn.isConnected){btn.textContent=label;btn.disabled=false;}
      const purpose=purposeForPage(),pending=pendingCode(purpose);
      if(pending && root.querySelector('[data-mail-stage]'))updateMailTimer(purpose,pending);
    }
    return true;
  }
  async function act(op,id){
    if(working)return;working=true;
    try{
      if(op==='reload-notifications'){await loadNotifications();return;}
      if(op==='reload-wallet'){await loadWallet();return;}
      if(op==='continue-topup'){if(wallet?.pendingTopup?.redirect_url)openTopup(wallet.pendingTopup.redirect_url);return;}
      if(op==='check-topup'){
        try{await api('/me/wallet/top-ups/'+encodeURIComponent(id)+'/refresh','POST',{});}finally{await loadWallet();}
        return;
      }
      if(op==='retry-mail'){await checkMail();return;}
      if(op==='change-email'){sessionStorage.removeItem(codeKey);emailHint='';render();return;}
      if(op==='resend-code'){
        const purpose=purposeForPage(),pending=pendingCode(purpose);
        if(pending)await sendCode(pending.email,purpose);else render();
        return;
      }
      if(op==='logout'){await api('/auth/logout','POST',{});AFEAuth.end();return;}
      if(op==='order'){await getPayments().resume(await api('/me/orders/'+encodeURIComponent(id)+'/resume','POST',{}));return;}
      if(op==='reload-orders'){await loadOrders();return;}
      if(op==='unlink' && confirm(tr('Unlink this card from AFE Charge?','确认从 AFE Charge 解绑这张卡吗？')))profile=await api('/me/cards/'+id,'DELETE');
      if(op==='default')profile=await api('/me/vehicles/'+id,'PUT',{isDefault:true});
      if(op==='remove-vehicle' && confirm(tr('Remove this vehicle?','确定移除这辆车吗？')))profile=await api('/me/vehicles/'+id,'DELETE');
      render();
    }catch(e){announce(mailError(e,purposeForPage()),true);}finally{working=false;}
  }
  async function start(){
    if(AFEAuth.token()){
      try {await refresh();}
      catch(e){if(e.code==='DELETION_PENDING'){profile={user:{},vehicles:[],cards:[]};initial='delete';}
        else {initial='login';notice=describe(e);}}
    }
    validating=false;
    if(profile && willVisit && !initial){initial=willVisit;willVisit='';}
    if(!initial && !profile){
      if(pendingCode('register'))initial='register';
      else if(pendingCode('reset'))initial='forgot';
    }
    let next=initial || (profile && getPayments().hasOrder()?'orders':!profile && AFEAuth.wasSignedOut()?'login':'home');
    if(next==='login' && profile)next='profile';
    return target(next);
  }
  return {screen,target,enter,start,submit,act,directCards:()=>(profile?.cards || []).filter(c=>c.direct),chargeControls,wallet:()=>wallet,loadWallet,active:()=>!!profile,hasVehicles:()=>!!profile?.vehicles?.length,
    handles:page=>page==='account-loading'||protectedPages.has(page)||publicPages.has(page)};
}
