### Singbox-nodejs

### 功能说明

* 精简化：去除哪吒、argo 隧道，保留 3 种协议：TUIC、Hysteria2、VLESS + Reality

* UUID 自动生成并固定保存，Reality 密钥也会固定保存

* 每天北京时间 00:03 自动重启 Sing-box，清理运行缓存

* TCP/UDP 端口可共用

* 新版优化：公网 IP 检测增加备用接口，并自动识别国家/运营商

* 节点链接备注会自动带线路信息，例如：Reality-US-Cloudflare、TUIC-JP-Amazon、Hysteria2-HK-Akamai，方便区分服务器

### 使用说明

1. 上传 `start.sh`、`index.js`、`package.json`

2. 设置环境变量：`TUIC_PORT`、`HY2_PORT`、`REALITY_PORT`

3. 启动项目，`index.js` 会自动调用 `bash start.sh`

### 端口说明

`TUIC_PORT`、`HY2_PORT`、`REALITY_PORT` 可按需填写，留空或设置为 `0` 表示不启用对应协议。至少需要启用一个协议端口。
