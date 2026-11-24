'use strict';
const AFEAuth = (() => {
  const key='afe.driver.v1.'+AFE_BASE_URL, signedOut=key+'.signed-out', payKey='afe.production.payment.v2.'+AFE_BASE_URL;
  let timer, session;
  function read(store) { try {return JSON.parse(store.getItem(key));} catch {return null;} }
  function clearPrivate() { try {sessionStorage.removeItem(payKey);sessionStorage.removeItem('afe.intent.'+AFE_BASE_URL);sessionStorage.removeItem('afe.production.payment.v1.'+AFE_BASE_URL);} catch {} }
  function valid(s) {return typeof s?.token==='string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(s.token) && Number.isFinite(s.expiresAt) && s.expiresAt>Date.now();}
  function end() {
    clearTimeout(timer);session=null;clearPrivate();
    localStorage.removeItem(key);sessionStorage.removeItem(key);localStorage.setItem(signedOut,'yes');
    const url=new URL(location.href);url.searchParams.set('account','login');url.hash='';
    location.replace(url.href);
  }
  function schedule() {clearTimeout(timer); if(session) timer=setTimeout(end,Math.max(0,session.expiresAt-Date.now()));}
  function begin(data,remember) {
    if (!valid(data)) throw new ChargeApiError(502,'INVALID_SESSION');
    const next={token:data.token,expiresAt:data.expiresAt};
    clearPrivate();localStorage.removeItem(key);sessionStorage.removeItem(key);
    (remember?localStorage:sessionStorage).setItem(key,JSON.stringify(next));
    localStorage.removeItem(signedOut);session=next;schedule();
  }
  const saved=read(sessionStorage) || read(localStorage);
  if(valid(saved)){session=saved;schedule();}
  else if(saved){clearPrivate();localStorage.removeItem(key);sessionStorage.removeItem(key);localStorage.setItem(signedOut,'yes');}
  window.addEventListener('storage',e=>{if(e.storageArea===localStorage &&
    ((e.key===key && !read(sessionStorage)) || (e.key===signedOut && e.newValue==='yes'))) {
      clearPrivate();if(e.key===signedOut) sessionStorage.removeItem(key);location.reload();
    }});
  window.addEventListener('pageshow',e=>{if(e.persisted) location.reload();});
  return {token:()=>valid(session)?session.token:null,begin,end,wasSignedOut:()=>localStorage.getItem(signedOut)==='yes'};
})();
