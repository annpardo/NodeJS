#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

// ================== 运行变量 ==================
process.env.HY2_PORT = process.env.HY2_PORT || ""; // Hysteria2 入站端口，留空表示关闭
process.env.REALITY_PORT = process.env.REALITY_PORT || ""; // VLESS Reality 入站端口，留空表示关闭
process.env.ARGO_PORT = process.env.ARGO_PORT || "8080"; // Argo 模式下本地 WebSocket 入站端口
process.env.ARGO_DOMAIN = process.env.ARGO_DOMAIN || ""; // Argo 固定隧道域名，留空时使用临时 trycloudflare.com 域名
process.env.ARGO_TOKEN = process.env.ARGO_TOKEN || ""; // Argo 固定隧道 Token，留空时使用临时隧道
process.env.REALITY_SNI = process.env.REALITY_SNI || "www.nazhumi.com"; // Reality 握手 SNI 和目标域名
process.env.CHAT_ID = process.env.CHAT_ID || ""; // Telegram Chat ID，与 BOT_TOKEN 同时设置才会推送
process.env.BOT_TOKEN = process.env.BOT_TOKEN || ""; // Telegram Bot Token，与 CHAT_ID 同时设置才会推送
process.env.CF_MODE = process.env.CF_MODE || ""; // argo 表示使用 Cloudflare Tunnel，cdn 表示使用 Cloudflare 橙云代理，留空表示两者都不启用；不区分大小写
process.env.CF_DOMAIN = process.env.CF_DOMAIN || ""; // CDN 模式使用的自有域名
process.env.CF_ORIGIN_PORT = process.env.CF_ORIGIN_PORT || ""; // CDN 模式源站端口，留空表示不启用 CDN 源站入站
process.env.RESTART_TIME = process.env.RESTART_TIME || ""; // 北京时间定时重启，格式 HH:MM，留空表示关闭

// ================== 内置 Xray CDN/Argo 启动逻辑 ==================
const embeddedScript = String.raw`#!/bin/bash
set -e

# ================== 强制切换到脚本所在目录 ==================
cd "$(dirname "$0")"

# ================== 环境变量 & 绝对路径 ==================
export FILE_PATH="${'${'}PWD}/.npm"
mkdir -p "$FILE_PATH"

# ================== UUID 固定保存（核心逻辑）==================
UUID_FILE="${'${'}FILE_PATH}/uuid.txt"
if [ -f "$UUID_FILE" ]; then
  UUID=$(cat "$UUID_FILE")
  echo -e "\e[1;33m[UUID] 复用固定 UUID: $UUID\e[0m"
else
  UUID=$(cat /proc/sys/kernel/random/uuid)
  echo "$UUID" > "$UUID_FILE"
  chmod 600 "$UUID_FILE"
  echo -e "\e[1;32m[UUID] 首次生成并永久保存: $UUID\e[0m"
fi

# ================== 创建目录 ==================
[ ! -d "${'${'}FILE_PATH}" ] && mkdir -p "${'${'}FILE_PATH}"

# ================== Cloudflare 模式 ==================
CF_MODE=$(printf "%s" "${'${'}CF_MODE:-}" | tr "[:upper:]" "[:lower:]")
case "$CF_MODE" in
  ""|argo|cdn) ;;
  *) echo "不支持的 CF_MODE: $CF_MODE（可选留空、argo 或 cdn）"; exit 1 ;;
esac
[ "$CF_MODE" = "cdn" ] && [ "$CF_DOMAIN" = "" ] && echo "[CDN] 未设置 CF_DOMAIN，无法生成 CDN 域名节点"
[ "$CF_MODE" = "cdn" ] && [ "$CF_ORIGIN_PORT" = "" ] && { echo "[CDN] 未设置 CF_ORIGIN_PORT，请填写服务器分配的端口"; exit 1; }
# ================== 架构检测 & 下载 Xray ==================
ARCH=$(uname -m)
BASE_URL=""
if [[ "$ARCH" == "arm"* ]] || [[ "$ARCH" == "aarch64" ]]; then
  BASE_URL="https://arm64.ssss.nyc.mn"
elif [[ "$ARCH" == "amd64"* ]] || [[ "$ARCH" == "x86_64" ]]; then
  BASE_URL="https://amd64.ssss.nyc.mn"
else
  echo "不支持的架构: $ARCH"
  exit 1
fi

FILE_INFOS=("web xray")
if [ "$CF_MODE" = "argo" ]; then
  FILE_INFOS+=("bot argo")
fi
declare -A FILE_MAP

download_file() {
  local URL=$1
  local FILENAME=$2
  if command -v curl >/dev/null 2>&1; then
    curl -L -sS -o "$FILENAME" "$URL" && echo -e "\e[1;32m下载 $FILENAME (curl)\e[0m"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$FILENAME" "$URL" && echo -e "\e[1;32m下载 $FILENAME (wget)\e[0m"
  else
    echo -e "\e[1;31m未找到 curl 或 wget\e[0m"
    exit 1
  fi
}

download_component() {
  local NAME="$1"
  local URL_PART="$2"
  local DOWNLOAD_URL
  local NEW_NAME="${'${'}FILE_PATH}/$(head /dev/urandom | tr -dc a-z0-9 | head -c6)"
  local TEMP_FILE="${'${'}NEW_NAME}.tmp.$$"

  if [[ "$URL_PART" == http://* ]] || [[ "$URL_PART" == https://* ]]; then
    DOWNLOAD_URL="$URL_PART"
  else
    DOWNLOAD_URL="${'${'}BASE_URL}/${'${'}URL_PART}"
  fi

  rm -f "$TEMP_FILE" 2>/dev/null || true
  download_file "$DOWNLOAD_URL" "$TEMP_FILE"
  chmod +x "$TEMP_FILE"
  mv -f "$TEMP_FILE" "$NEW_NAME"
  FILE_MAP[$NAME]="$NEW_NAME"
}

for entry in "${'${'}FILE_INFOS[@]}"; do
  URL=$(echo "$entry" | cut -d ' ' -f1)
  NAME=$(echo "$entry" | cut -d ' ' -f2)
  download_component "$NAME" "$URL"
done

# ================== 固定 Reality 密钥 ==================
KEY_FILE="${'${'}FILE_PATH}/key.txt"
private_key=""
public_key=""
if [ "$REALITY_PORT" != "" ]; then
  if [ -f "$KEY_FILE" ]; then
    echo -e "\e[1;33m[密钥] 检测到已有密钥，复用...\e[0m"
    private_key=$(awk -F: '/^[[:space:]]*Private([[:space:]]*[Kk]ey|Key)[[:space:]]*:/ {value=$2; sub(/^[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value); print value; exit}' "$KEY_FILE")
    public_key=$(awk -F: '/^[[:space:]]*(Public([[:space:]]*[Kk]ey|Key)|Password[[:space:]]*\([[:space:]]*PublicKey[[:space:]]*\))[[:space:]]*:/ {value=$2; sub(/^[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value); print value; exit}' "$KEY_FILE")
  else
    echo -e "\e[1;33m[密钥] 首次生成 Reality 密钥对...\e[0m"
    output=$("${'${'}FILE_MAP[xray]}" x25519)
    echo "$output" > "$KEY_FILE"
    private_key=$(echo "$output" | awk -F: '/^[[:space:]]*Private([[:space:]]*[Kk]ey|Key)[[:space:]]*:/ {value=$2; sub(/^[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value); print value; exit}')
    public_key=$(echo "$output" | awk -F: '/^[[:space:]]*(Public([[:space:]]*[Kk]ey|Key)|Password[[:space:]]*\([[:space:]]*PublicKey[[:space:]]*\))[[:space:]]*:/ {value=$2; sub(/^[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value); print value; exit}')
    chmod 600 "$KEY_FILE"
    echo -e "\e[1;32m[密钥] 密钥已保存，重启后保持不变\e[0m"
  fi

  if [ -z "$private_key" ] || [ -z "$public_key" ]; then
    echo "[密钥] 无法解析 Xray Reality 密钥，请检查 $KEY_FILE 中是否包含 PrivateKey 和 PublicKey"
    exit 1
  fi
else
  echo "[密钥] Reality 未启用，跳过 Reality 密钥生成"
fi

# ================== 生成证书（自签或固定）==================
if ! command -v openssl >/dev/null 2>&1; then
  cat > "${'${'}FILE_PATH}/private.key" <<'EOF'
-----BEGIN EC PARAMETERS-----
BgqghkjOPQQBw==
-----END EC PARAMETERS-----
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/+siNnfBYsdUYsAoGCCqGSM49
AwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASAnngZreoQDF16ARa
/TsyLyFoPkhTxSbehH/OBEjHtSZGaDhMqQ==
-----END EC PRIVATE KEY-----
EOF
  cat > "${'${'}FILE_PATH}/cert.pem" <<'EOF'
-----BEGIN CERTIFICATE-----
MIIBejCCASGgAwIBAgIUFWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwMTAxMDEwMTAwWhcNMzUwMTAxMDEw
MTAwWjATMREwDwYDVQQDDAhiaW5nLmNvbTBNBgqgGzM9AgEGCCqGSM49AwEHA0IA
BNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdeWv07Mi8h
d5IR8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBQTV1cFID7UISE7PLTBR
BfGbgrkMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgrkMNzAPBgNVHRMB
Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIARDAJvg0vd/ytrQVvEcSm6XTlB+
eQ6OFb9LbLYL9Zi+AiffoMbi4y/0YUQlTtz7as9S8/lciBF5VCUoVIKS+vX2g==
-----END CERTIFICATE-----
EOF
else
  openssl ecparam -genkey -name prime256v1 -out "${'${'}FILE_PATH}/private.key" 2>/dev/null
  openssl req -new -x509 -days 3650 -key "${'${'}FILE_PATH}/private.key" -out "${'${'}FILE_PATH}/cert.pem" -subj "/CN=bing.com" 2>/dev/null
fi
chmod 600 "${'${'}FILE_PATH}/private.key"

# ================== 生成 Xray config.json ==================
INBOUNDS_JSON=""
add_inbound() {
  local item="$1"
  if [ "$INBOUNDS_JSON" = "" ]; then
    INBOUNDS_JSON="$item"
  else
    INBOUNDS_JSON="${'${'}INBOUNDS_JSON},${'${'}item}"
  fi
}

[ "$HY2_PORT" != "" ] && [ "$HY2_PORT" != "0" ] && add_inbound "$(cat <<EOF
{
  "tag": "hysteria2-in",
  "listen": "::",
  "port": $HY2_PORT,
  "protocol": "hysteria",
  "settings": {
    "version": 2,
    "clients": [{"auth": "$UUID"}]
  },
  "streamSettings": {
    "network": "hysteria",
    "hysteriaSettings": {
      "version": 2,
      "masquerade": {"type": "proxy", "url": "https://bing.com"}
    },
    "security": "tls",
    "tlsSettings": {
      "alpn": ["h3"],
      "certificates": [{
        "certificateFile": "${'${'}FILE_PATH}/cert.pem",
        "keyFile": "${'${'}FILE_PATH}/private.key"
      }]
    }
  }
}
EOF
)"

[ "$REALITY_PORT" != "" ] && add_inbound "$(cat <<EOF
{
  "tag": "vless-reality-in",
  "listen": "::",
  "port": $REALITY_PORT,
  "protocol": "vless",
  "settings": {
    "clients": [{"id": "$UUID", "flow": "xtls-rprx-vision"}],
    "decryption": "none"
  },
  "streamSettings": {
    "network": "raw",
    "security": "reality",
    "realitySettings": {
      "show": false,
      "dest": "${'${'}REALITY_SNI}:443",
      "xver": 0,
      "serverNames": ["${'${'}REALITY_SNI}"],
      "privateKey": "$private_key",
      "shortIds": [""]
    }
  }
}
EOF
)"

if [ "$CF_MODE" = "argo" ]; then
  add_inbound "$(cat <<EOF
{
  "tag": "vless-argo-ws-in",
  "listen": "127.0.0.1",
  "port": $ARGO_PORT,
  "protocol": "vless",
  "settings": {
    "clients": [{"id": "$UUID"}],
    "decryption": "none"
  },
  "streamSettings": {
    "network": "ws",
    "security": "none",
    "wsSettings": {"path": "/vless-ws"}
  }
}
EOF
  )"
elif [ "$CF_MODE" = "cdn" ]; then
  add_inbound "$(cat <<EOF
{
  "tag": "vless-cdn-ws-in",
  "listen": "::",
  "port": $CF_ORIGIN_PORT,
  "protocol": "vless",
  "settings": {
    "clients": [{"id": "$UUID"}],
    "decryption": "none"
  },
  "streamSettings": {
    "network": "ws",
    "security": "tls",
    "tlsSettings": {
      "certificates": [{
        "certificateFile": "${'${'}FILE_PATH}/cert.pem",
        "keyFile": "${'${'}FILE_PATH}/private.key"
      ]
    },
    "wsSettings": {"path": "/vless-ws"}
  }
}
EOF
  )"
fi

write_xray_config() {
  cat > "${'${'}FILE_PATH}/config.json" <<EOF
{
  "log": {"loglevel": "none"},
  "inbounds": [
$INBOUNDS_JSON
  ],
  "outbounds": [{"protocol": "freedom", "tag": "direct"}]
}
EOF
}

write_xray_config

# ================== 启动 Xray ==================
nohup "${'${'}FILE_MAP[xray]}" -c "${'${'}FILE_PATH}/config.json" > /dev/null 2>&1 &
XRAY_PID=$!
printf "%s\n" "$XRAY_PID" > "${'${'}FILE_PATH}/xray.pid"
echo "[XRAY] 启动完成 PID=$XRAY_PID"

# ================== 启动 Argo 隧道 ==================
ARGO_HOST=""
ARGO_LOG="${'${'}FILE_PATH}/bot.log"

start_argo() {
  [ "$CF_MODE" != "argo" ] && return

  : > "$ARGO_LOG"
  if [ "$ARGO_TOKEN" != "" ]; then
    nohup "${'${'}FILE_MAP[argo]}" tunnel --edge-ip-version auto --protocol http2 --ha-connections 4 --no-autoupdate run --token "$ARGO_TOKEN" > "$ARGO_LOG" 2>&1 &
    ARGO_PID=$!
    ARGO_HOST="$ARGO_DOMAIN"
    echo "[ARGO] 固定隧道启动完成 PID=$ARGO_PID"
    [ "$ARGO_HOST" = "" ] && echo "[ARGO] 固定隧道需要设置 ARGO_DOMAIN 才能生成节点"
  else
    nohup "${'${'}FILE_MAP[argo]}" tunnel --edge-ip-version auto --protocol http2 --url "http://127.0.0.1:${'${'}ARGO_PORT}" --no-autoupdate > "$ARGO_LOG" 2>&1 &
    ARGO_PID=$!
    echo "[ARGO] 临时隧道启动完成 PID=$ARGO_PID"

    for i in $(seq 1 20); do
      ARGO_HOST=$(grep -o 'https://[-a-zA-Z0-9.]*\.trycloudflare\.com' "$ARGO_LOG" | head -n 1 | sed 's#https://##')
      [ "$ARGO_HOST" != "" ] && break
      sleep 1
    done
  fi

  if [ "$ARGO_HOST" != "" ]; then
    echo "[ARGO] 域名: $ARGO_HOST"
  else
    echo "[ARGO] 未获取到域名，请检查 $ARGO_LOG"
  fi
}

start_argo
if [ "$CF_MODE" = "cdn" ]; then
  ARGO_HOST="$CF_DOMAIN"
fi

# ================== 获取 IP & ISP ==================
fetch_text() {
  curl -A "Mozilla/5.0" -H "Accept: */*" -s --max-time "$2" "$1" 2>/dev/null || true
}

json_get() {
  echo "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

join_isp() {
  local country="$1"
  local org="$2"
  if [ "$country" != "" ] && [ "$org" != "" ]; then
    echo "${'${'}country}-${'${'}org}"
  elif [ "$country" != "" ]; then
    echo "$country"
  elif [ "$org" != "" ]; then
    echo "$org"
  else
    echo ""
  fi
}

get_ip() {
  local ip
  ip=$(fetch_text "https://api.ipify.org" 2)
  [ "$ip" != "" ] && echo "$ip" && return
  ip=$(fetch_text "https://ipv4.ip.sb" 2)
  [ "$ip" != "" ] && echo "$ip" && return
  echo "IP_ERROR"
}

get_isp() {
  local data country org isp

  data=$(fetch_text "https://api.ip.sb/geoip" 5)
  if [ "$data" != "" ]; then
    country=$(json_get "$data" "country_code")
    org=$(json_get "$data" "organization")
    [ "$org" = "" ] && org=$(json_get "$data" "isp")
    [ "$org" = "" ] && org=$(json_get "$data" "asn_organization")
    isp=$(join_isp "$country" "$org")
    [ "$isp" != "" ] && echo "$isp" && return
  fi

  data=$(fetch_text "https://ipapi.co/json/" 5)
  if [ "$data" != "" ]; then
    country=$(json_get "$data" "country_code")
    org=$(json_get "$data" "org")
    [ "$org" = "" ] && org=$(json_get "$data" "asn")
    isp=$(join_isp "$country" "$org")
    [ "$isp" != "" ] && echo "$isp" && return
  fi

  data=$(fetch_text "http://ip-api.com/json" 5)
  if [ "$data" != "" ]; then
    country=$(json_get "$data" "countryCode")
    org=$(json_get "$data" "isp")
    [ "$org" = "" ] && org=$(json_get "$data" "org")
    [ "$org" = "" ] && org=$(json_get "$data" "as")
    isp=$(join_isp "$country" "$org")
    [ "$isp" != "" ] && echo "$isp" && return
  fi

  echo "0.0"
}

IP=$(get_ip)
ISP=$(get_isp)

# ================== 生成订阅 ==================
LINKS=""
add_link() {
  local link="$1"
  LINKS="${'${'}LINKS}${'${'}link}
"
  echo "$link"
}

[ "$HY2_PORT" != "" ] && [ "$HY2_PORT" != "0" ] && add_link "hysteria2://${'${'}UUID}@${'${'}IP}:${'${'}HY2_PORT}/?sni=www.bing.com&insecure=1#Hysteria2-${'${'}ISP}"
[ "$REALITY_PORT" != "" ] && add_link "vless://${'${'}UUID}@${'${'}IP}:${'${'}REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${'${'}REALITY_SNI}&fp=firefox&pbk=${'${'}public_key}&type=tcp&headerType=none#Reality-${'${'}ISP}"
add_argo_vless_link() {
  local server="$1"
  local port="$2"
  add_link "vless://${'${'}UUID}@${'${'}server}:${'${'}port}?encryption=none&security=tls&fp=chrome&type=ws&host=${'${'}ARGO_HOST}&path=/vless-ws%3Fed%3D2560&sni=${'${'}ARGO_HOST}#VLESS-${'${'}ISP}"
}

if [ "$CF_MODE" = "cdn" ]; then
  ARGO_SERVER="$CF_DOMAIN"
  [ "$ARGO_SERVER" != "" ] && add_argo_vless_link "$ARGO_SERVER" "443"
elif [ "$ARGO_HOST" != "" ]; then
  ARGO_SERVER="$ARGO_HOST"
  add_argo_vless_link "$ARGO_SERVER" "443"
fi

# 不再生成 sub.txt，Telegram 直接发送原始 LINKS。
rm -f "${'${'}FILE_PATH}/sub.txt" 2>/dev/null || true

# ================== Telegram 推送 ==================
send_telegram() {
  if [ "$BOT_TOKEN" = "" ] || [ "$CHAT_ID" = "" ]; then
    echo -e "\e[1;33m[TG] 未设置 BOT_TOKEN 或 CHAT_ID，跳过推送\e[0m"
    return
  fi

  local message local_message response
  if [ "$LINKS" = "" ]; then
    echo -e "\e[1;33m[TG] 没有可发送的节点链接，跳过推送\e[0m"
    return
  fi

  message=$(printf "%s" "$LINKS")
  local_message="${'${'}ISP} 节点推送通知
${'${'}message}"

  response=$(curl -s -X POST "https://api.telegram.org/bot${'${'}BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${'${'}CHAT_ID}" \
    --data-urlencode "text=${'${'}local_message}" 2>/dev/null || true)

  if echo "$response" | grep -q '"ok":true'; then
    echo -e "\e[1;32m[TG] 节点配置已发送到 Telegram\e[0m"
  else
    echo -e "\e[1;31m[TG] Telegram 推送失败\e[0m"
    [ "$response" != "" ] && echo "$response"
  fi
}

send_telegram

# ================== 定时删除敏感文件 ==================
INITIAL_XRAY_PATH="${'${'}FILE_MAP[xray]}"
INITIAL_ARGO_PATH=""
[ "$CF_MODE" = "argo" ] && INITIAL_ARGO_PATH="${'${'}FILE_MAP[argo]}"
{
  sleep 20
  rm -f "$ARGO_LOG" "${'${'}FILE_PATH}/config.json" "$INITIAL_XRAY_PATH" "$INITIAL_ARGO_PATH" 2>/dev/null || true
  echo "[清理] 已删除 bot.log、config.json、核心程序和 Argo 程序文件"
} &

# ★★★ 关键：保持脚本前台运行，不能退出

`;

const restartCoreScript = String.raw`#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
FILE_PATH="$PWD/.npm"
mkdir -p "$FILE_PATH"
CF_MODE=$(printf "%s" "$CF_MODE" | tr "[:upper:]" "[:lower:]")
ARCH=$(uname -m)
if [[ "$ARCH" == "arm"* ]] || [[ "$ARCH" == "aarch64" ]]; then
  BASE_URL="https://arm64.ssss.nyc.mn"
elif [[ "$ARCH" == "amd64"* ]] || [[ "$ARCH" == "x86_64" ]]; then
  BASE_URL="https://amd64.ssss.nyc.mn"
else
  echo "不支持的架构: $ARCH"; exit 1
fi

download_file() {
  local URL=$1 FILENAME=$2
  if command -v curl >/dev/null 2>&1; then
    curl -L -sS -o "$FILENAME" "$URL" && echo -e "\e[1;32m下载 $FILENAME (curl)\e[0m"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$FILENAME" "$URL" && echo -e "\e[1;32m下载 $FILENAME (wget)\e[0m"
  else
    echo -e "\e[1;31m未找到 curl 或 wget\e[0m"
    exit 1
  fi
}
download_component() {
  local NAME="$1"
  local URL_PART="$2"
  local DOWNLOAD_URL
  local NEW_NAME="$FILE_PATH/$(head /dev/urandom | tr -dc a-z0-9 | head -c6)"
  local TEMP_FILE="${'${'}NEW_NAME}.tmp.$$"
  if [[ "$URL_PART" == http://* ]] || [[ "$URL_PART" == https://* ]]; then
    DOWNLOAD_URL="$URL_PART"
  else
    DOWNLOAD_URL="$BASE_URL/$URL_PART"
  fi
  rm -f "$TEMP_FILE" 2>/dev/null || true
  download_file "$DOWNLOAD_URL" "$TEMP_FILE"
  chmod +x "$TEMP_FILE"
  mv -f "$TEMP_FILE" "$NEW_NAME"
  FILE_MAP[$NAME]="$NEW_NAME"
}
UUID=$(cat "$FILE_PATH/uuid.txt")
REALITY_SNI="$REALITY_SNI"
HY2_PORT="$HY2_PORT"
REALITY_PORT="$REALITY_PORT"
CF_MODE=$(printf "%s" "$CF_MODE" | tr "[:upper:]" "[:lower:]")
CF_ORIGIN_PORT="$CF_ORIGIN_PORT"
ARGO_PORT="$ARGO_PORT"
private_key=""
public_key=""
if [ -f "$FILE_PATH/key.txt" ]; then
  private_key=$(awk -F: '/^[[:space:]]*Private([[:space:]]*[Kk]ey|Key)[[:space:]]*:/ {value=$2; sub(/^[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value); print value; exit}' "$FILE_PATH/key.txt")
  public_key=$(awk -F: '/^[[:space:]]*(Public([[:space:]]*[Kk]ey|Key)|Password[[:space:]]*\([[:space:]]*PublicKey[[:space:]]*\))[[:space:]]*:/ {value=$2; sub(/^[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value); print value; exit}' "$FILE_PATH/key.txt")
fi
INBOUNDS_JSON=""
add_inbound() {
  local item="$1"
  if [ "$INBOUNDS_JSON" = "" ]; then INBOUNDS_JSON="$item"; else INBOUNDS_JSON="$INBOUNDS_JSON,$item"; fi
}
[ "$HY2_PORT" != "" ] && [ "$HY2_PORT" != "0" ] && add_inbound "$(cat <<EOF
{
  "tag": "hysteria2-in", "listen": "::", "port": $HY2_PORT, "protocol": "hysteria",
  "settings": {"version": 2, "clients": [{"auth": "$UUID"}]},
  "streamSettings": {"network": "hysteria", "hysteriaSettings": {"version": 2, "masquerade": {"type": "proxy", "url": "https://bing.com"}}, "security": "tls", "tlsSettings": {"alpn": ["h3"], "certificates": [{"certificateFile": "$FILE_PATH/cert.pem", "keyFile": "$FILE_PATH/private.key"}]}}
}
EOF
  )"
[ "$REALITY_PORT" != "" ] && add_inbound "$(cat <<EOF
{
  "tag": "vless-reality-in", "listen": "::", "port": $REALITY_PORT, "protocol": "vless",
  "settings": {"clients": [{"id": "$UUID", "flow": "xtls-rprx-vision"}], "decryption": "none"},
  "streamSettings": {"network": "raw", "security": "reality", "realitySettings": {"show": false, "dest": "$REALITY_SNI:443", "xver": 0, "serverNames": ["$REALITY_SNI"], "privateKey": "$private_key", "shortIds": [""]}}
}
EOF
  )"
if [ "$CF_MODE" = "argo" ]; then
  add_inbound "$(cat <<EOF
{"tag":"vless-argo-ws-in","listen":"127.0.0.1","port":$ARGO_PORT,"protocol":"vless","settings":{"clients":[{"id":"$UUID"}],"decryption":"none"},"streamSettings":{"network":"ws","security":"none","wsSettings":{"path":"/vless-ws"}}}
EOF
  )"
elif [ "$CF_MODE" = "cdn" ]; then
  add_inbound "$(cat <<EOF
{"tag":"vless-cdn-ws-in","listen":"::","port":$CF_ORIGIN_PORT,"protocol":"vless","settings":{"clients":[{"id":"$UUID"}],"decryption":"none"},"streamSettings":{"network":"ws","security":"tls","tlsSettings":{"certificates":[{"certificateFile":"$FILE_PATH/cert.pem","keyFile":"$FILE_PATH/private.key"}]},"wsSettings":{"path":"/vless-ws"}}}
EOF
  )"
fi
write_xray_config() {
  cat > "$FILE_PATH/config.json" <<EOF
{"log":{"loglevel":"none"},"inbounds":[
$INBOUNDS_JSON
],"outbounds":[{"protocol":"freedom","tag":"direct"}]}
EOF
}

OLD_XRAY_PID=$(cat "$FILE_PATH/xray.pid" 2>/dev/null || true)
if [ -n "$OLD_XRAY_PID" ]; then kill "$OLD_XRAY_PID" 2>/dev/null || true; fi
sleep 3
write_xray_config
declare -A FILE_MAP
download_component "xray" "web"
nohup "${'${'}FILE_MAP[xray]}" -c "$FILE_PATH/config.json" > /dev/null 2>&1 &
XRAY_PID=$!
printf "%s\n" "$XRAY_PID" > "$FILE_PATH/xray.pid"
RESTARTED_XRAY_PATH="${'${'}FILE_MAP[xray]}"
{ sleep 20; rm -f "$RESTARTED_XRAY_PATH" 2>/dev/null || true; } &
echo "[Xray重启完成] 新 PID: $XRAY_PID"
`;

setInterval(() => {}, 3600000);

const child = spawn('bash', ['-c', embeddedScript], {
  cwd: __dirname,
  env: process.env,
  stdio: 'inherit',
});

let schedulerStarted = false;

child.on('error', (error) => {
  console.error('[启动失败]', error.message);
});

child.on('close', (code) => {
  if (code !== 0) {
    console.error(`[初始化失败] Bash 退出码=${code}`);
    return;
  }
  if (!schedulerStarted) {
    schedulerStarted = true;
    scheduleNextCoreRestart();
  }
});

const restartTime = (process.env.RESTART_TIME || '').trim();
let restartTimer = null;
let restartRunning = false;

function getNextBeijingRestart(timeText) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeText);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const nowMs = Date.now();
  const beijingNow = new Date(nowMs + 8 * 60 * 60 * 1000);
  let targetMs = Date.UTC(beijingNow.getUTCFullYear(), beijingNow.getUTCMonth(), beijingNow.getUTCDate(), hour, minute, 0, 0) - 8 * 60 * 60 * 1000;
  if (targetMs <= nowMs) targetMs += 24 * 60 * 60 * 1000;
  return targetMs;
}

function scheduleNextCoreRestart() {
  if (!restartTime) {
    console.log('[定时重启] 未设置 RESTART_TIME，已关闭自动重启');
    return;
  }
  const nextRestartMs = getNextBeijingRestart(restartTime);
  if (nextRestartMs === null) {
    console.log(`[定时重启] RESTART_TIME 格式无效：${restartTime}（应为 HH:MM），已关闭自动重启`);
    return;
  }
  const delay = nextRestartMs - Date.now();
  console.log(`[定时重启] 已启用，北京时间每天 ${restartTime} 重启核心程序`);
  restartTimer = setTimeout(runCoreRestart, delay);
}

function runCoreRestart() {
  if (restartRunning) {
    console.log('[定时重启] 上一次核心重启尚未结束，本次跳过');
    scheduleNextCoreRestart();
    return;
  }
  restartRunning = true;
  const restartChild = spawn('bash', ['-c', restartCoreScript], { cwd: __dirname, env: process.env, stdio: 'inherit' });
  let finished = false;
  function finishRestart() {
    if (finished) return;
    finished = true;
    restartRunning = false;
    scheduleNextCoreRestart();
  }
  restartChild.on('error', (error) => {
    console.error('[定时重启] 无法启动核心重启任务:', error.message);
    finishRestart();
  });
  restartChild.on('close', (code) => {
    if (code === 0) console.log('[定时重启] 核心重启任务执行完成');
    else console.error(`[定时重启] 核心重启任务失败，退出码=${code}`);
    finishRestart();
  });
}
