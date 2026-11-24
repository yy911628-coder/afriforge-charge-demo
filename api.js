'use strict';
const AFE_API_MOCK_MODE = false;
const AFE_BASE_URL = window.AFE_CONFIG?.AFE_PRODUCTION_BASE_URL;

class ChargeApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const AFEApi = (() => {
  function endpoint(path) {
    if (!AFE_BASE_URL) throw new ChargeApiError(0, 'PRODUCTION_BACKEND_NOT_CONFIGURED');
    let base;
    try { base = new URL(AFE_BASE_URL); } catch { throw new ChargeApiError(0, 'INVALID_PRODUCTION_BACKEND'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
        base.pathname !== '/' || base.hostname.toLowerCase().includes('sandbox')) {
      throw new ChargeApiError(0, 'INVALID_PRODUCTION_BACKEND');
    }
    return new URL(path, base.origin);
  }

  async function request(path, pass, body) {
    const url = endpoint(path);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 35000);
    try {
      const headers = {Accept: 'application/json'};
      if (pass !== undefined) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(pass)) throw new ChargeApiError(0, 'INVALID_OPERATOR_PASS');
        headers.Authorization = 'Bearer ' + pass;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(url, {
        headers, method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      let data;
      try { data = await response.json(); } catch { throw new ChargeApiError(response.status, 'INVALID_BACKEND_RESPONSE'); }
      if (data?.environment !== 'production') throw new ChargeApiError(response.status, 'PRODUCTION_FEED_UNCONFIRMED');
      if (!response.ok) {
        throw new ChargeApiError(response.status, typeof data.error === 'string' && /^[A-Z0-9_]{1,90}$/.test(data.error)
          ? data.error : 'BACKEND_ERROR');
      }
      return data;
    } finally { clearTimeout(deadline); }
  }
  return Object.freeze({
    stations: () => request('/api/ocpi/stations'),
    paymentCapabilities: () => request('/api/payments/capabilities'),
    createCheckout: (pass, body) => request('/api/payments/checkout', pass, body),
    paymentStatus: pass => request('/api/payments/status', pass),
    commandCapabilities: () => request('/api/ocpi/command-capabilities'),
    sessionStatus: pass => request('/api/ocpi/session-status', pass),
    startSession: (pass,target) => request('/api/ocpi/start-session',pass,{target}),
    stopSession: (pass,target) => request('/api/ocpi/stop-session',pass,{target})
  });
})();
