AFE Charge · iPhone PWA · v37

在线入口 https://yy911628-coder.github.io/afriforge-charge-demo/?v=afe-v37
用 iPhone 的 Safari 打开，点“分享 → 添加到主屏幕”。“我的”“钱包”“订单”均需登录，首页场站与扫码可公开浏览。
本机验收入口 http://127.0.0.1:4180/ 由 Start-AFE-AccountPreview.ps1 启动。账号保存在本机 local-login.json。注册验证码保存在本机 last-verification-email.json，重置邮件保存在 last-reset-email.json。
正式新账户须先通过六位邮箱验证码验证。服务端配置 AFE_EMAIL_FROM 和 Secret Manager 中的 AFE_EMAIL_API_KEY 后可使用已验证的 Resend 发件域名。发信开通前暂停新注册，已有账户可登录，并可在“账户安全”查看邮箱验证状态。
地图使用 Leaflet 1.9.4（BSD-2-Clause，见 leaflet.LICENSE）和 OpenStreetMap。Rivonia 区域底图由 2026-11-24 的公开道路、水系、公园与地名数据绘制，© OpenStreetMap contributors，数据许可 ODbL（https://www.openstreetmap.org/copyright）。该底图随 App 提供。区域中心采用 Rivonia 地名坐标，桩点坐标来自生产 OCPI。
正式支付需开通 Peach Live 并确定预授权金额。海汇德生产目录、启停回调与实桩计量待双方联调。

以下为 v21 历史演示说明
AFE Charge · iPhone PWA demo · v21

Live HTTPS demo
https://yy911628-coder.github.io/afriforge-charge-demo/?v=afe-v21

Install or refresh on iPhone
1. Open the link above in Safari while online.
2. Tap Share → Add to Home Screen.
3. For an existing home-screen app, open the v21 link in Safari once, then close and reopen the app. If the old cached screen remains, remove the old icon and add it again.

Demo flow
Find a station → choose a connector → set amount/energy/battery limit → choose card or wallet → start → adjust limit or stop → review payment reconciliation → history → simulated invoice.

CPO partner flow
1. Tap “CPO view” in the header. Stations rank by utilisation relative to break-even energy and show simulated demand cost share, utilisation, partnership model and estimated payback months.
2. Open a station to review its Grid only / Solar + Storage / Smart scheduling resilience label. “Simulate load-shedding” shows grid-only locations as unavailable while solar/storage and smart-scheduled locations remain startable.
3. Tap “Driver view” → “Scan QR to start · demo”. Choose Personal for simulated card pre-authorisation/release, or Fleet for monthly account billing.
4. A fleet session is added to the simulated monthly statement with vehicle/plate, session count, kWh, amount, settlement cycle and payment status.

Demo limits
This is a static PWA with simulated station/session/payment and CPO economics data. It does not connect to chargers, vehicles, a backend or a payment provider. Card authorisation, wallet and fleet settlement are simulated and no money is charged. History and preferences are stored locally in this browser/device. Economic, utilisation and payback values are illustrative, not forecasts.


Camera scanning in v21
Open the Scan tab and tap “Open camera to scan QR”. Safari asks for camera access after the tap. Allow access while using the site. The camera stream stops when you leave the scan screen. If QR recognition cannot load, enter the charger code below. Use HTTPS; camera access does not work from a file:// URL.

New in v7
Map/list view with Google Maps JavaScript API integration and simulated station markers. Live map rendering needs a Google Maps browser key. Add it to config.js at window.AFE_CONFIG.GOOGLE_MAPS_API_KEY; restrict it by referrer to the published Pages site and local development origin, and enable Maps JavaScript API. The key is visible in browser code, so never use an unrestricted key. Directions open the Google Maps directions URL.

Guest QR flow, local wallet top-ups, demo card form (only last four digits are saved), four languages, theme/font settings, emergency guide, feedback form and help centre are included. Preferences and demo records are stored in this browser's localStorage. The card form never sends or saves the full card number, expiry or CVV.


AFE Charge v7 UX update
The app now uses a full-viewport mobile layout, safe-area-aware bottom navigation and sheets, light/dark design tokens, a static illustrated map fallback with mock markers, and an animated guest QR scanner plus connection sequence. Language changes re-render the current screen immediately. Local storage failures are handled without crashing.
