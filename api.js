'use strict';
const AFE_API_MOCK_MODE = false;
const AFE_BASE_URL = window.AFE_CONFIG?.AFE_BASE_URL;

class ChargeApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const AFEApi = (() => {
  async function request(path, {method = 'GET', body, token} = {}) {
    let base;
    try { base = new URL(AFE_BASE_URL); } catch { throw new ChargeApiError(0, 'BACKEND_NOT_CONFIGURED'); }
    const loopback = ['127.0.0.1','localhost','[::1]'].includes(base.hostname);
    if (base.username || base.password || (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:'))) {
      throw new ChargeApiError(0, 'INVALID_BACKEND_URL');
    }
    const headers = {Accept:'application/json'};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(new URL(path,base.origin), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials:'omit', cache:'no-store', redirect:'error', referrerPolicy:'no-referrer', signal:controller.signal
      });
      let data;
      try { data = await response.json(); } catch { throw new ChargeApiError(response.status,'INVALID_BACKEND_RESPONSE'); }
      if (!response.ok) {
        throw new ChargeApiError(response.status, typeof data?.error === 'string' && /^[A-Z0-9_]{1,90}$/.test(data.error)
          ? data.error : 'BACKEND_ERROR');
      }
      return data;
    } finally { clearTimeout(deadline); }
  }
  return Object.freeze({
    stations: token => request('/api/ocpi/stations', {token}),
    checkout: (token,target) => request('/api/payments/checkout',{method:'POST',token,body:target}),
    payment: (token,id) => request('/api/payments/status?attemptId='+encodeURIComponent(id),{token}),
    status: (token,id) => request('/api/ocpi/session-status?attemptId='+encodeURIComponent(id),{token}),
    start: (token,id,target) => request('/api/ocpi/start-session',{method:'POST',token,body:{attemptId:id,...target}}),
    stop: (token,id) => request('/api/ocpi/stop-session',{method:'POST',token,body:{attemptId:id}})
  });
})();
