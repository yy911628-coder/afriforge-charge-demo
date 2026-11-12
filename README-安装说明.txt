Afriforge Charge iPhone 网页 App（原型版）

内容
- index.html：可交互的手机端原型
- manifest.webmanifest：网页 App 安装信息
- service-worker.js：基础离线缓存
- apple-touch-icon.png、icon-192.png、icon-512.png、icon-maskable-512.png：主屏幕图标

安装到 iPhone
1. 用 iPhone Safari 打开 https://yy911628-coder.github.io/afriforge-charge-demo/ 。
2. 点“分享”→“添加到主屏幕”；如出现“作为网页 App 打开”，将其打开，再点“添加”。
3. 从主屏幕图标打开原型。首次联网打开后，静态页面和图标会写入缓存，可离线再次打开。

注意
- 当前是交互式设计原型，不包含真实用户账户、OCPP/充电桩连接、订单、支付、邮件发票或后台服务；示例数据仅用于演示。
- 该页面公开部署于 GitHub Pages，任何拿到网址的人都可能访问。不要在此原型中输入真实支付或个人信息。
