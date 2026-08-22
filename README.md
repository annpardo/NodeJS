# Xray / sing-box 节点运行脚本

这是一组单文件 Node.js 脚本，用于在 Linux 服务器上自动运行 Xray 或 sing-box，并生成 VLESS Reality、Hysteria2、TUIC（仅 sing-box）和 Cloudflare WebSocket 节点。

脚本会自动完成程序下载、配置生成、Reality 密钥保存、TLS 证书生成、Cloudflare 接入、节点链接生成和 Telegram 推送。

## 文件

| 文件 | 核心程序 | 支持协议 |
| --- | --- | --- |
| `index-xray-cdn.js` | Xray | VLESS Reality、Hysteria2、VLESS WebSocket |
| `index-singbox-cdn.js` | sing-box | VLESS Reality、Hysteria2、TUIC、VLESS WebSocket |

Xray 不提供 TUIC，因此 Xray 版本不会生成 TUIC 节点。

## 环境要求

- Linux ARM64 或 AMD64
- Node.js
- Bash
- `curl` 或 `wget`
- `openssl`（可选；没有时使用内置证书）
- 能够访问程序下载地址和 Cloudflare API

脚本会根据系统架构下载对应程序：

```text
ARM64: https://arm64.ssss.nyc.mn
AMD64: https://amd64.ssss.nyc.mn
```

下载的程序使用随机文件名保存，路径记录在 `.npm/bin.path` 中，后续重启会复用已下载的程序。

## Cloudflare 模式

`CF_MODE` 有三种取值，大小写不敏感：

```text
argo   使用 Cloudflare Tunnel
cdn    使用 Cloudflare 橙云代理
留空   不启用 Argo，也不生成 CDN WebSocket 入站
```

### Argo 模式

```bash
CF_MODE=argo node index-xray-cdn.js
```

固定隧道需要设置：

```bash
CF_MODE=argo \
ARGO_DOMAIN=tunnel.example.com \
ARGO_TOKEN=你的Token \
node index-xray-cdn.js
```

如果 `ARGO_DOMAIN` 和 `ARGO_TOKEN` 都为空，脚本会启动临时 `trycloudflare.com` 隧道。

Argo 模式下，Xray 或 sing-box 的 WebSocket 入站只监听本机，Cloudflared 负责转发流量。

### CDN 模式

CDN 模式需要先在 Cloudflare 中添加域名 DNS 记录并打开橙云代理。

```bash
CF_MODE=cdn \
CF_DOMAIN=example.com \
CF_ORIGIN_PORT=443 \
CF_PUBLIC_PORT=443 \
node index-xray-cdn.js
```

CDN 模式下，核心程序会监听 `CF_ORIGIN_PORT`，并生成 TLS WebSocket 入站。节点链接使用 `CF_DOMAIN` 和 `CF_PUBLIC_PORT`。

Cloudflare 后台的 SSL/TLS 模式、源站端口和脚本变量必须保持一致。Reality 和 Hysteria2 通常不能通过普通橙云 CDN 代理，应使用直连或 DNS-only 域名。

## 变量

两个脚本都支持以下通用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HY2_PORT` | 空 | Hysteria2 入站端口，留空关闭 |
| `REALITY_PORT` | `41579` | VLESS Reality 入站端口，留空关闭 |
| `REALITY_SNI` | `www.nazhumi.com` | Reality 握手 SNI 和目标域名 |
| `ARGO_PORT` | `8080` | Argo 模式下的本地 WebSocket 端口 |
| `ARGO_DOMAIN` | 空 | 固定 Argo 隧道域名 |
| `ARGO_TOKEN` | 空 | 固定 Argo 隧道 Token |
| `CF_MODE` | 空 | `argo`、`cdn` 或留空 |
| `CF_DOMAIN` | 空 | CDN 模式使用的域名 |
| `CF_ORIGIN_PORT` | `443` | CDN 模式源站监听端口 |
| `CF_PUBLIC_PORT` | `443` | CDN 节点链接使用的端口 |
| `CHAT_ID` | 空 | Telegram Chat ID |
| `BOT_TOKEN` | 空 | Telegram Bot Token |

sing-box 版本额外支持：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TUIC_PORT` | 空 | TUIC 入站端口，留空关闭 |

## 面板使用

1. 将所需脚本上传到面板服务器的 `/home/container` 目录。
2. 在面板中设置主文件：
   - Xray：`index-xray-cdn.js`
   - sing-box：`index-singbox-cdn.js`
3. 在面板的环境变量中填写端口、Cloudflare 和 Telegram 参数。
4. 启动服务器，脚本会自动下载或复用核心程序并生成节点。

如果面板的启动命令错误地把 `.js` 文件交给 `ts-node`，可以上传一个 `index.ts` 启动器：

```ts
require("./index-xray-cdn.js");
```

然后将主文件设置为 `index.ts`，并确保 `package.json` 中包含 `ts-node` 和 `typescript`。

## 注意事项

- `index-xray-cdn.js` 不支持 TUIC，TUIC 只在 sing-box 版本中提供。
- CDN 模式需要自己的域名、Cloudflare 橙云 DNS 和正确的 SSL/TLS 配置。
- 临时 Argo 域名可能在隧道进程结束后失效。
- 下载地址提供的程序属于外部构建，使用前应自行核对来源和文件哈希。
- 不要让两个脚本同时使用同一个工作目录，否则可能互相覆盖 `.npm` 内的配置、密钥和缓存记录。
