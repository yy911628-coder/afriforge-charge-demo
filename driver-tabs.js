'use strict';

const driverIcons = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  wallet: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 1 4 15.5z"/><path d="M4 7h14a2 2 0 0 1 2 2v8M15 12h5M6.5 21H20"/><circle cx="16.5" cy="12" r=".7"/>',
  orders: '<path d="M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M8 12h8M8 16h8"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2z"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 7h4v4H7zM14 7h3v3h-3zM14 14h3v3h-3zM7 14h2v3H7z"/>'
};

function driverNav(tr, page) {
  const tabs = [
    ['home', tr('Home','首页')], ['wallet', tr('Wallet','钱包')],
    ['scan', tr('Scan','扫码')], ['orders', tr('Orders','订单')], ['profile', tr('Profile','我的')]
  ];
  const active = tabs.some(([key]) => key === page) ? page : 'home';
  const buttons = tabs.map(([key, label]) => {
    return `<button type="button" data-page="${key}" class="${active === key ? 'active' : ''}"
      ${active === key ? 'aria-current="page"' : ''}>
      <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="25" height="25"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${driverIcons[key]}</svg></span>
      <span>${label}</span></button>`;
  }).join('');
  return `<nav class="app-nav" aria-label="${tr('Main navigation','主导航')}">${buttons}</nav>`;
}

function driverTab({page, tr, paymentCard = '', hasOrder = false}) {
  function tabLink(to, label) {
    return `<button type="button" class="app-button secondary full" data-page="${to}">${label}</button>`;
  }
  if (page === 'wallet') {
    return `<div class="wallet-page"><div class="wallet-title-row"><h1>${tr('Wallet','钱包')}</h1></div>
      ${paymentCard}</div>`;
  }
  if (page === 'orders') {
    return `<div class="wallet-title-row"><h1>${tr('Orders','订单')}</h1></div>
      ${hasOrder ? '' : `<div class="wallet-empty order-empty"><span class="wallet-empty-icon" aria-hidden="true">▤</span>
        <b>${tr('No order open on this device','此设备上暂无已打开的订单')}</b></div>`}
      ${paymentCard}`;
  }
  if (page === 'profile') {
    return `<h1>${tr('Profile','我的')}</h1><section class="app-card rec-card">
      <h2>${tr('Language','语言')}</h2>
      <button type="button" class="rec-refresh" data-act="language">${tr('切换到中文','Switch to English')}</button></section>
      ${tabLink('orders',tr('Charging orders','充电订单'))}`;
  }
  if (page === 'scan') {
    return `<h1>${tr('Scan a charger','扫码找桩')}</h1><section class="app-card rec-card">
      <div class="scan-camera"><video data-scan-video playsinline muted hidden></video>
        <i aria-hidden="true" class="scanner-corner tl"></i><i aria-hidden="true" class="scanner-corner tr"></i>
        <i aria-hidden="true" class="scanner-corner bl"></i><i aria-hidden="true" class="scanner-corner br"></i>
        <span class="scan-camera-status" data-camera-status role="status">${tr('Scan the QR code on the charger','请扫描桩屏上的二维码')}</span></div>
      <div class="scan-camera-actions"><button type="button" class="app-button" data-act="scan-camera">${tr('Open camera','打开相机')}</button>
        <button type="button" class="app-button secondary" data-act="stop-camera" hidden>${tr('Close camera','关闭相机')}</button></div>
      <form data-driver-code class="rec-picker"><label for="driver-code">${tr('Or enter the charger code','也可以输入充电桩编号')}</label>
        <input class="app-input" id="driver-code" name="code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="1024" required>
        <button type="submit" class="rec-refresh">${tr('Find charger','查找充电桩')}</button></form>
      <p role="status" data-scan-message></p></section>`;
  }
  return '';
}

// QR payloads are data only. Match a published identifier exactly, without following a URL.
function driverResolveCode(raw, locations) {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!code || code.length > 1024) return {kind:'unmatched'};
  const matches = [];
  locations.forEach((site,siteIndex) => {
    for (const evse of site.evses) {
      for (const connector of evse.connectors) {
        const identity = [site.country_code,site.party_id,site.id,evse.uid,connector.id];
        const qualified = identity.map(encodeURIComponent).join('/');
        if (code === qualified || (connector.id.length >= 8 && code === connector.id)) {
          matches.push({kind:'connector',siteIndex,evseUid:evse.uid,connectorId:connector.id});
        }
      }
    }
  });
  if (matches.length > 1) return {kind:'ambiguous'};
  return matches[0] || {kind:code === 'ZA41020001000001000100' ? 'report' : 'unmatched'};
}

let driverCamera = null;
let driverQrDecoder = null;

function driverStopCamera() {
  const capture = driverCamera;
  driverCamera = null;
  if (!capture) return;
  clearTimeout(capture.timer);
  capture.stream?.getTracks().forEach(track => track.stop());
  capture.video.pause();
  capture.video.srcObject = null;
  capture.video.hidden = true;
  capture.open.disabled = false;
  capture.close.hidden = true;
  capture.status.textContent = capture.idleText;
}

function loadDriverQrDecoder() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!driverQrDecoder) {
    driverQrDecoder = new Promise((resolve,reject) => {
      const script = document.createElement('script');
      // Packaged locally from jsqr 1.4.0 (Apache 2.0). Frames stay on the device.
      script.src = new URL('./jsQR.js',document.baseURI).href;
      script.async = true;
      script.onload = () => window.jsQR ? resolve(window.jsQR) : reject(new Error('QR_DECODER_UNAVAILABLE'));
      script.onerror = () => reject(new Error('QR_DECODER_UNAVAILABLE'));
      document.head.appendChild(script);
    }).catch(error => { driverQrDecoder = null; throw error; });
  }
  return driverQrDecoder;
}

async function driverScanCamera({root,tr,onCode}) {
  if (driverCamera) return;
  const video = root.querySelector('[data-scan-video]');
  if (!video) return;
  const status = root.querySelector('[data-camera-status]');
  const open = root.querySelector('[data-act="scan-camera"]');
  const close = root.querySelector('[data-act="stop-camera"]');
  const idleText = tr('Scan the QR code on the charger','请扫描桩屏上的二维码');
  const unavailable = tr('Camera unavailable. Enter the charger code below.','相机暂不可用，请在下方输入充电桩编号。');
  if (!navigator.mediaDevices?.getUserMedia) { status.textContent = unavailable; return; }
  const capture = {video,status,open,close,idleText,stream:null,timer:null};
  driverCamera = capture;
  open.disabled = true;
  close.hidden = false;
  status.textContent = tr('Opening camera…','正在打开相机…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
    if (driverCamera !== capture || !video.isConnected) {
      stream.getTracks().forEach(track => track.stop());
      if (driverCamera === capture) driverStopCamera();
      return;
    }
    capture.stream = stream;
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    const decode = await loadDriverQrDecoder();
    if (driverCamera !== capture) return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d',{willReadFrequently:true});
    if (!context) throw new Error('CANVAS_UNAVAILABLE');
    status.textContent = idleText;
    function frame() {
      if (driverCamera !== capture) return;
      if (!video.isConnected || document.hidden) { driverStopCamera(); return; }
      try {
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          const scale = Math.min(1, 840 / Math.max(video.videoWidth,video.videoHeight));
          canvas.width = Math.max(1,Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1,Math.round(video.videoHeight * scale));
          context.drawImage(video,0,0,canvas.width,canvas.height);
          const pixels = context.getImageData(0,0,canvas.width,canvas.height);
          const value = decode(pixels.data,pixels.width,pixels.height)?.data;
          if (value) { driverStopCamera(); onCode(value); return; }
        }
      } catch { driverStopCamera(); status.textContent = unavailable; return; }
      capture.timer = setTimeout(frame,250);
    }
    frame();
  } catch (error) {
    if (driverCamera !== capture) return;
    driverStopCamera();
    status.textContent = error.name === 'NotAllowedError' ? tr('Camera access was declined. Enter the charger code below.','未获得相机权限，请在下方输入充电桩编号。') : unavailable;
  }
}

window.addEventListener('pagehide',driverStopCamera);
document.addEventListener('visibilitychange',() => { if (document.hidden) driverStopCamera(); });
