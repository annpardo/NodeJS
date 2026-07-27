# Cloudflare CDN 非 Argo 版使用说明

这个版本保留原脚本中的 TUIC、Hysteria2、Reality、Cloudflare 优选地址和 Telegram 推送功能，只用普通 Cloudflare CDN 替换 Argo Tunnel。

## 新增的三个参数

```bash
# VLESS+WS+TLS 使用的翼龙面板固定端口
export WS_PORT=${WS_PORT:-"26952"}

# Cloudflare 已开启橙云代理的域名
export CF_DOMAIN=${CF_DOMAIN:-"vless.tinc1210.dpdns.org"}

# self_signed 自动生成自签证书；origin 使用手动上传的证书
export TLS_CERT_MODE=${TLS_CERT_MODE:-"self_signed"}
```

原有的以下参数仍然保留：

```text
TUIC_PORT
HY2_PORT
REALITY_PORT
CF_PREFERRED_DOMAIN
CF_PREFERRED_PORT
CHAT_ID
BOT_TOKEN
```

## Cloudflare 设置

DNS 记录需要开启橙云代理，并创建 Origin Rule：

```text
条件：Hostname equals vless.tinc1210.dpdns.org
操作：Destination port rewrite = 26952
```

客户端连接 Cloudflare 的 `443`，Cloudflare再回源到翼龙面板端口 `26952`。

## 证书模式

### self_signed

脚本会自动生成并复用自签证书：

```text
.npm/cert.pem
.npm/private.key
```

Cloudflare SSL/TLS 模式必须设置为：

```text
Full
```

### origin

将一份证书和一份未加密私钥上传到脚本所在目录，然后设置：

```bash
export TLS_CERT_MODE=${TLS_CERT_MODE:-"origin"}
```

脚本会根据文件内容自动识别，支持常见的 `.pem`、`.crt`、`.cer` 和 `.key` 文件。目录中不要同时保留多组证书。

Cloudflare Origin CA 或可信 CA 证书应使用：

```text
Full (strict)
```

## VLESS 客户端参数

```text
地址：vless.tinc1210.dpdns.org
端口：443
传输：WebSocket
TLS：开启
Host：vless.tinc1210.dpdns.org
SNI：vless.tinc1210.dpdns.org
Path：/vless-ws
```

如果设置了 `CF_PREFERRED_DOMAIN`，只有客户端连接地址发生变化，Host 和 SNI 仍然使用 `CF_DOMAIN`。
