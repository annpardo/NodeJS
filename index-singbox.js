#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

// ================== 运行变量 ==================
process.env.TUIC_PORT = process.env.TUIC_PORT || ""; // TUIC 入站端口，留空表示关闭
process.env.HY2_PORT = process.env.HY2_PORT || ""; // Hysteria2 入站端口，留空表示关闭
process.env.REALITY_PORT = process.env.REALITY_PORT || "41579"; // VLESS Reality 入站端口，留空表示关闭
process.env.ARGO_PORT = process.env.ARGO_PORT || "8080"; // Argo 模式下本地 WebSocket 入站端口
process.env.ARGO_DOMAIN = process.env.ARGO_DOMAIN || ""; // Argo 固定隧道域名，留空时使用临时 trycloudflare.com 域名
process.env.ARGO_TOKEN = process.env.ARGO_TOKEN || ""; // Argo 固定隧道 Token，留空时使用临时隧道
process.env.REALITY_SNI = process.env.REALITY_SNI || "www.nazhumi.com"; // Reality 握手 SNI 和目标域名
process.env.CHAT_ID = process.env.CHAT_ID || ""; // Telegram Chat ID，与 BOT_TOKEN 同时设置才会推送
process.env.BOT_TOKEN = process.env.BOT_TOKEN || ""; // Telegram Bot Token，与 CHAT_ID 同时设置才会推送
process.env.CF_MODE = process.env.CF_MODE || ""; // argo 表示使用 Cloudflare Tunnel，cdn 表示使用 Cloudflare 橙云代理，留空表示两者都不启用；不区分大小写
process.env.CF_DOMAIN = process.env.CF_DOMAIN || ""; // CDN 模式使用的自有域名
process.env.CF_ORIGIN_PORT = process.env.CF_ORIGIN_PORT || "443"; // CDN 模式源站端口，sing-box 对外监听此端口
process.env.CF_PUBLIC_PORT = process.env.CF_PUBLIC_PORT || "443"; // CDN 节点链接中的端口

// ================== 内置 sing-box CDN/Argo 启动逻辑 ==================
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
# ================== 架构检测 & 下载 sing-box ==================
ARCH=$(uname -m)
BASE_URL=""
if [[ "$ARCH" == "arm"* ]] || [[ "$ARCH" == "aarch64" ]]; then
  BASE_URL="https://arm64.ssss.nyc.mn"
elif [[ "$ARCH" == "amd64"* ]] || [[ "$ARCH" == "x86_64" ]]; then
  BASE_URL="https://amd64.ssss.nyc.mn"
elif [[ "$ARCH" == "s390x" ]]; then
  BASE_URL="https://s390x.ssss.nyc.mn"
else
  echo "不支持的架构: $ARCH"
  exit 1
fi

FILE_INFOS=("sbx-1.13.13 sing-box")
if [ "$CF_MODE" = "argo" ]; then
  FILE_INFOS+=("bot argo")
fi
declare -A FILE_MAP
BIN_PATH_FILE="${'${'}FILE_PATH}/bin.path"

load_cached_path() {
  local name="$1"
  local cached_path

  [ -f "$BIN_PATH_FILE" ] || return 1
  cached_path=$(awk -F '\t' -v wanted="$name" '$1 == wanted {print $2; exit}' "$BIN_PATH_FILE" 2>/dev/null || true)
  if [ -n "$cached_path" ] && [ -s "$cached_path" ] && [ -x "$cached_path" ] && "$cached_path" version >/dev/null 2>&1; then
    FILE_MAP[$name]="$cached_path"
    echo -e "\e[1;33m[缓存] 复用已下载的 $name: $cached_path\e[0m"
    return 0
  fi
  return 1
}

save_cached_path() {
  local name="$1"
  local path="$2"
  local temp_file="${'${'}BIN_PATH_FILE}.tmp.$$"

  {
    [ -f "$BIN_PATH_FILE" ] && awk -F '\t' -v wanted="$name" '$1 != wanted' "$BIN_PATH_FILE"
    printf '%s\t%s\n' "$name" "$path"
  } > "$temp_file"
  mv -f "$temp_file" "$BIN_PATH_FILE"
  chmod 600 "$BIN_PATH_FILE"
}

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

for entry in "${'${'}FILE_INFOS[@]}"; do
  URL=$(echo "$entry" | cut -d ' ' -f1)
  NAME=$(echo "$entry" | cut -d ' ' -f2)
  if [[ "$URL" == http://* ]] || [[ "$URL" == https://* ]]; then
    DOWNLOAD_URL="$URL"
  else
    DOWNLOAD_URL="${'${'}BASE_URL}/${'${'}URL}"
  fi

  load_cached_path "$NAME" && continue

  NEW_NAME="${'${'}FILE_PATH}/$(head /dev/urandom | tr -dc a-z0-9 | head -c6)"
  TEMP_FILE="${'${'}NEW_NAME}.tmp.$$"
  rm -f "$TEMP_FILE" 2>/dev/null || true
  download_file "$DOWNLOAD_URL" "$TEMP_FILE"
  chmod +x "$TEMP_FILE"
  mv -f "$TEMP_FILE" "$NEW_NAME"
  FILE_MAP[$NAME]="$NEW_NAME"
  save_cached_path "$NAME" "$NEW_NAME"
done

# ================== 固定 Reality 密钥 ==================
KEY_FILE="${'${'}FILE_PATH}/key.txt"
if [ -f "$KEY_FILE" ]; then
  echo -e "\e[1;33m[密钥] 检测到已有密钥，复用...\e[0m"
  private_key=$(grep "PrivateKey:" "$KEY_FILE" | awk '{print $2}')
  public_key=$(grep "PublicKey:" "$KEY_FILE" | awk '{print $2}')
else
  echo -e "\e[1;33m[密钥] 首次生成 Reality 密钥对...\e[0m"
  output=$("${'${'}FILE_MAP[sing-box]}" generate reality-keypair)
  echo "$output" > "$KEY_FILE"
  private_key=$(echo "$output" | awk '/PrivateKey:/ {print $2}')
  public_key=$(echo "$output" | awk '/PublicKey:/ {print $2}')
  chmod 600 "$KEY_FILE"
  echo -e "\e[1;32m[密钥] 密钥已保存，重启后保持不变\e[0m"
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

# ================== 生成 config.json ==================
INBOUNDS_JSON=""
add_inbound() {
  local item="$1"
  if [ "$INBOUNDS_JSON" = "" ]; then
    INBOUNDS_JSON="$item"
  else
    INBOUNDS_JSON="${'${'}INBOUNDS_JSON},${'${'}item}"
  fi
}

[ "$TUIC_PORT" != "" ] && [ "$TUIC_PORT" != "0" ] && add_inbound "$(cat <<EOF
{
  "type": "tuic",
  "listen": "::",
  "listen_port": $TUIC_PORT,
  "users": [{"uuid": "$UUID", "password": "admin"}],
  "congestion_control": "bbr",
  "tls": {
    "enabled": true,
    "alpn": ["h3"],
    "certificate_path": "${'${'}FILE_PATH}/cert.pem",
    "key_path": "${'${'}FILE_PATH}/private.key"
  }
}
EOF
)"

[ "$HY2_PORT" != "" ] && [ "$HY2_PORT" != "0" ] && add_inbound "$(cat <<EOF
{
  "type": "hysteria2",
  "listen": "::",
  "listen_port": $HY2_PORT,
  "users": [{"password": "$UUID"}],
  "masquerade": "https://bing.com",
  "tls": {
    "enabled": true,
    "alpn": ["h3"],
    "certificate_path": "${'${'}FILE_PATH}/cert.pem",
    "key_path": "${'${'}FILE_PATH}/private.key"
  }
}
EOF
)"

[ "$REALITY_PORT" != "" ] && [ "$REALITY_PORT" != "0" ] && add_inbound "$(cat <<EOF
{
  "type": "vless",
  "listen": "::",
  "listen_port": $REALITY_PORT,
  "users": [{"uuid": "$UUID", "flow": "xtls-rprx-vision"}],
  "tls": {
    "enabled": true,
    "server_name": "${'${'}REALITY_SNI}",
    "reality": {
      "enabled": true,
      "handshake": {"server": "${'${'}REALITY_SNI}", "server_port": 443},
      "private_key": "$private_key",
      "short_id": [""]
    }
  }
}
EOF
)"

if [ "$CF_MODE" = "argo" ]; then
  add_inbound "$(cat <<EOF
{
  "type": "vless",
  "listen": "127.0.0.1",
  "listen_port": $ARGO_PORT,
  "users": [{"uuid": "$UUID"}],
  "transport": {
    "type": "ws",
    "path": "/vless-ws",
    "max_early_data": 2560,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  }
}
EOF
  )"
elif [ "$CF_MODE" = "cdn" ]; then
  add_inbound "$(cat <<EOF
{
  "type": "vless",
  "listen": "::",
  "listen_port": $CF_ORIGIN_PORT,
  "users": [{"uuid": "$UUID"}],
  "tls": {
    "enabled": true,
    "certificate_path": "${'${'}FILE_PATH}/cert.pem",
    "key_path": "${'${'}FILE_PATH}/private.key"
  },
  "transport": {
    "type": "ws",
    "path": "/vless-ws",
    "max_early_data": 2560,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  }
}
EOF
  )"
fi

write_singbox_config() {
  cat > "${'${'}FILE_PATH}/config.json" <<EOF
{
  "log": {"disabled": true},
  "inbounds": [
$INBOUNDS_JSON
  ],
  "outbounds": [{"type": "direct"}]
}
EOF
}

write_singbox_config

# ================== 启动 sing-box ==================
"${'${'}FILE_MAP[sing-box]}" run -c "${'${'}FILE_PATH}/config.json" &
SINGBOX_PID=$!
echo "[SING-BOX] 启动完成 PID=$SINGBOX_PID"

# ================== 启动 Argo 隧道 ==================
ARGO_HOST=""
ARGO_LOG="${'${'}FILE_PATH}/bot.log"

start_argo() {
  [ "$CF_MODE" != "argo" ] && return

  : > "$ARGO_LOG"
  if [ "$ARGO_TOKEN" != "" ]; then
    "${'${'}FILE_MAP[argo]}" tunnel --edge-ip-version auto --protocol http2 --ha-connections 4 --no-autoupdate run --token "$ARGO_TOKEN" > "$ARGO_LOG" 2>&1 &
    ARGO_PID=$!
    ARGO_HOST="$ARGO_DOMAIN"
    echo "[ARGO] 固定隧道启动完成 PID=$ARGO_PID"
    [ "$ARGO_HOST" = "" ] && echo "[ARGO] 固定隧道需要设置 ARGO_DOMAIN 才能生成节点"
  else
    "${'${'}FILE_MAP[argo]}" tunnel --edge-ip-version auto --protocol http2 --url "http://127.0.0.1:${'${'}ARGO_PORT}" --no-autoupdate > "$ARGO_LOG" 2>&1 &
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

[ "$TUIC_PORT" != "" ] && [ "$TUIC_PORT" != "0" ] && add_link "tuic://${'${'}UUID}:admin@${'${'}IP}:${'${'}TUIC_PORT}?sni=www.bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#TUIC-${'${'}ISP}"
[ "$HY2_PORT" != "" ] && [ "$HY2_PORT" != "0" ] && add_link "hysteria2://${'${'}UUID}@${'${'}IP}:${'${'}HY2_PORT}/?sni=www.bing.com&insecure=1#Hysteria2-${'${'}ISP}"
[ "$REALITY_PORT" != "" ] && [ "$REALITY_PORT" != "0" ] && add_link "vless://${'${'}UUID}@${'${'}IP}:${'${'}REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${'${'}REALITY_SNI}&fp=firefox&pbk=${'${'}public_key}&type=tcp#Reality-${'${'}ISP}"
add_argo_vless_link() {
  local server="$1"
  local port="$2"
  add_link "vless://${'${'}UUID}@${'${'}server}:${'${'}port}?encryption=none&security=tls&fp=chrome&type=ws&host=${'${'}ARGO_HOST}&path=/vless-ws%3Fed%3D2560&sni=${'${'}ARGO_HOST}#VLESS-${'${'}ISP}"
}

if [ "$CF_MODE" = "cdn" ]; then
  ARGO_SERVER="$CF_DOMAIN"
  [ "$ARGO_SERVER" != "" ] && add_argo_vless_link "$ARGO_SERVER" "$CF_PUBLIC_PORT"
elif [ "$ARGO_HOST" != "" ]; then
  add_argo_vless_link "$ARGO_HOST" "$CF_PUBLIC_PORT"
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

# ================== 启动定时重启（前台阻塞） ==================
schedule_restart() {
  echo "[定时重启:Sing-box] 已启动（北京时间 00:03）"
  LAST_RESTART_DAY=-1

  while true; do
    now_ts=$(date +%s)
    beijing_ts=$((now_ts + 28800))
    H=$(( (beijing_ts / 3600) % 24 ))
    M=$(( (beijing_ts / 60) % 60 ))
    D=$(( beijing_ts / 86400 ))

    # ---- 时间匹配 → 重启 sing-box ----
    if [ "$H" -eq 00 ] && [ "$M" -eq 03 ] && [ "$D" -ne "$LAST_RESTART_DAY" ]; then
      echo "[定时重启:Sing-box] 到达 00:03 → 重启 sing-box"
      LAST_RESTART_DAY=$D

      kill "$SINGBOX_PID" 2>/dev/null || true
      sleep 3

      write_singbox_config
      "${'${'}FILE_MAP[sing-box]}" run -c "${'${'}FILE_PATH}/config.json" &
      SINGBOX_PID=$!

      echo "[Sing-box重启完成] 新 PID: $SINGBOX_PID"
    fi

    sleep 1
  done
}

# ================== 定时删除敏感文件 ==================
{
  sleep 20
  rm -f "$ARGO_LOG" "${'${'}FILE_PATH}/config.json" 2>/dev/null || true
  echo "[清理] 已删除 bot.log 和 config.json"
} &

# ★★★ 关键：保持脚本前台运行，不能退出
schedule_restart


`;

const result = spawnSync('bash', ['-c', embeddedScript], {
  cwd: __dirname,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error('[启动失败]', result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);

