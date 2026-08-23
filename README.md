# Xray / sing-box 节点运行脚本

这是一组单文件 Node.js 脚本，用于在 Linux 服务器上自动运行 Xray 或 sing-box，并生成 VLESS Reality、Hysteria2、TUIC（仅 sing-box）和 Cloudflare WebSocket 节点。

脚本会自动完成程序下载、配置生成、Reality 密钥保存、TLS 证书生成、Cloudflare 接入、节点链接生成和 Telegram 推送。

## 文件

| 文件 | 核心程序 | 支持协议 |
| --- | --- | --- |
| `index-xray.js` | Xray | VLESS Reality、Hysteria2、VLESS WebSocket |
| `index-singbox.js` | sing-box | VLESS Reality、Hysteria2、TUIC、VLESS WebSocket |

Xray 不提供 TUIC，因此 Xray 版本不会生成 TUIC 节点。


## Cloudflare 模式

`CF_MODE` 有三种模式

```text
argo   使用 Cloudflare Tunnel
cdn    使用 Cloudflare 橙云代理
留空   不启用 Argo，也不生成 CDN WebSocket 入站
```

### Argo 模式

```bash
CF_MODE=argo node index-xray.js
```

固定隧道需要设置：

```bash
CF_MODE=argo \
ARGO_DOMAIN=tunnel.example.com \
ARGO_TOKEN=你的Token \
node index-xray.js
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
| `REALITY_PORT` | `` | VLESS Reality 入站端口，留空关闭 |
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
3. 在面板的环境变量中填写端口、Cloudflare 和 Telegram 参数。
4. 启动服务器，脚本会自动下载或复用核心程序并生成节点。

## 注意事项

- `index-xray.js` 不支持 TUIC，TUIC 只在 sing-box 版本中提供。
- CDN 模式需要自己的域名、Cloudflare 橙云 DNS 和正确的 SSL/TLS 配置。
- 临时 Argo 域名可能在隧道进程结束后失效。
- 不要让两个脚本同时使用同一个工作目录，否则可能互相覆盖 `.npm` 内的配置、密钥和缓存记录。
