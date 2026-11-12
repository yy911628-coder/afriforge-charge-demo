Afriforge Charge iPhone 网页 App（原型版）

内容
- index.html：可交互的手机端原型
- manifest.webmanifest：网页 App 安装信息
- service-worker.js：基础离线缓存
- apple-touch-icon.png、icon-192.png、icon-512.png、icon-maskable-512.png：主屏幕图标

安装到 iPhone
1. 将整个文件夹部署到一个启用 HTTPS 的网站（根目录或子目录均可）。发布后请将这些文件保存在同一个目录中。
2. 在 iPhone 上用 Safari 打开 https://你的域名/部署路径/index.html。
3. 点“分享”→“添加到主屏幕”；如出现“作为网页 App 打开”，将其打开，再点“添加”。
4. 从主屏幕图标打开原型。首次联网打开后，静态页面和图标会写入缓存，可离线再次打开。

注意
- 当前是交互式设计原型，不包含真实用户账户、OCPP/充电桩连接、订单、支付、邮件发票或后台服务；示例数据仅用于演示。
- 本文件夹还没有托管到公网，因此现在没有可直接输入 Safari 的网址。AirDrop/微信传 HTML 文件可用于文件传递，但不能替代 HTTPS 部署。
- HTTPS 托管可使用你自己的网站/静态站点托管服务；部署后任何拿到网址的人都能访问该演示页面。不要在此原型中输入真实支付或个人信息。
