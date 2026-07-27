#!/bin/bash
set -e

# TUIC 端口，留空或填写 0 表示关闭
export TUIC_PORT=${TUIC_PORT:-""}

# Hysteria2 端口，留空或填写 0 表示关闭
export HY2_PORT=${HY2_PORT:-""}

# Reality 端口，留空或填写 0 表示关闭
export REALITY_PORT=${REALITY_PORT:-""}

# VLESS+WS+TLS 使用的翼龙面板固定端口
export WS_PORT=${WS_PORT:-"26952"}

# Cloudflare 已开启橙云代理的域名
export CF_DOMAIN=${CF_DOMAIN:-""}

# 证书模式：self_signed 自动生成；origin 扫描脚本目录中上传的证书和私钥
export TLS_CERT_MODE=${TLS_CERT_MODE:-"self_signed"}

# Cloudflare 优选地址，留空则使用 CF_DOMAIN
export CF_PREFERRED_DOMAIN=${CF_PREFERRED_DOMAIN:-${PREFERRED_DOMAIN:-""}}

# 客户端连接 Cloudflare 的端口
export CF_PREFERRED_PORT=${CF_PREFERRED_PORT:-${PREFERRED_PORT:-"443"}}

# Telegram 接收消息的 Chat ID
export CHAT_ID=${CHAT_ID:-""}

# Telegram Bot Token
export BOT_TOKEN=${BOT_TOKEN:-""}

cd "$(dirname "$0")"

export FILE_PATH="${PWD}/.npm"
mkdir -p "$FILE_PATH"

UUID_FILE="${FILE_PATH}/uuid.txt"
if [ -f "$UUID_FILE" ]; then
  UUID=$(tr -d '\r\n' < "$UUID_FILE")
  echo -e "\e[1;33m[UUID] 复用固定 UUID: $UUID\e[0m"
else
  UUID=$(cat /proc/sys/kernel/random/uuid)
  echo "$UUID" > "$UUID_FILE"
  chmod 600 "$UUID_FILE"
  echo -e "\e[1;32m[UUID] 首次生成并保存: $UUID\e[0m"
fi

# 下载 sing-box
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

declare -A FILE_MAP

download_file() {
  local url="$1"
  local filename="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -L -sS -o "$filename" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$filename" "$url"
  else
    echo -e "\e[1;31m未找到 curl 或 wget\e[0m"
    exit 1
  fi
}

SING_BOX_FILE="${FILE_PATH}/$(head /dev/urandom | tr -dc a-z0-9 | head -c6)"
download_file "${BASE_URL}/sbx-1.13.13" "$SING_BOX_FILE"
chmod +x "$SING_BOX_FILE"
FILE_MAP[sing-box]="$SING_BOX_FILE"
echo -e "\e[1;32m下载 sing-box 完成\e[0m"

# Reality 密钥
KEY_FILE="${FILE_PATH}/key.txt"
if [ -f "$KEY_FILE" ]; then
  private_key=$(grep "PrivateKey:" "$KEY_FILE" | awk '{print $2}')
  public_key=$(grep "PublicKey:" "$KEY_FILE" | awk '{print $2}')
else
  output=$("${FILE_MAP[sing-box]}" generate reality-keypair)
  echo "$output" > "$KEY_FILE"
  private_key=$(echo "$output" | awk '/PrivateKey:/ {print $2}')
  public_key=$(echo "$output" | awk '/PublicKey:/ {print $2}')
  chmod 600 "$KEY_FILE"
fi

# TLS 证书
SELF_CERT_PATH="${FILE_PATH}/cert.pem"
SELF_KEY_PATH="${FILE_PATH}/private.key"
WS_CERT_PATH=""
WS_KEY_PATH=""
CF_SSL_MODE=""

generate_self_signed_certificate() {
  if [ -s "$SELF_CERT_PATH" ] && [ -s "$SELF_KEY_PATH" ]; then
    echo -e "\e[1;33m[证书] 复用已有自签证书\e[0m"
  else
    command -v openssl >/dev/null 2>&1 || {
      echo -e "\e[1;31m[证书] 自签模式需要 openssl\e[0m"
      exit 1
    }

    rm -f "$SELF_CERT_PATH" "$SELF_KEY_PATH"
    if ! openssl req -x509 -newkey rsa:2048 -nodes -sha256 \
      -days 3650 \
      -keyout "$SELF_KEY_PATH" \
      -out "$SELF_CERT_PATH" \
      -subj "/CN=${CF_DOMAIN}" \
      -addext "subjectAltName=DNS:${CF_DOMAIN}" >/dev/null 2>&1; then
      rm -f "$SELF_CERT_PATH" "$SELF_KEY_PATH"
      openssl req -x509 -newkey rsa:2048 -nodes -sha256 \
        -days 3650 \
        -keyout "$SELF_KEY_PATH" \
        -out "$SELF_CERT_PATH" \
        -subj "/CN=${CF_DOMAIN}" >/dev/null 2>&1
    fi

    echo -e "\e[1;32m[证书] 自签证书生成完成\e[0m"
  fi

}

scan_origin_certificate() {
  local file
  local cert_count=0
  local key_count=0

  while IFS= read -r -d '' file; do
    if grep -q -- '-----BEGIN CERTIFICATE-----' "$file" 2>/dev/null; then
      cert_count=$((cert_count + 1))
      WS_CERT_PATH="$file"
    fi

    if grep -Eq -- '-----BEGIN (RSA |EC )?PRIVATE KEY-----' "$file" 2>/dev/null; then
      key_count=$((key_count + 1))
      WS_KEY_PATH="$file"
    fi
  done < <(find "$PWD" -maxdepth 1 -type f \( -iname '*.pem' -o -iname '*.crt' -o -iname '*.cer' -o -iname '*.key' \) -print0)

  [ "$cert_count" -gt 0 ] || {
    echo -e "\e[1;31m[证书] 脚本目录中没有找到证书文件\e[0m"
    exit 1
  }

  [ "$key_count" -gt 0 ] || {
    echo -e "\e[1;31m[证书] 脚本目录中没有找到私钥文件\e[0m"
    exit 1
  }

  [ "$cert_count" -eq 1 ] || {
    echo -e "\e[1;31m[证书] 检测到多个证书文件，请只保留一份\e[0m"
    exit 1
  }

  [ "$key_count" -eq 1 ] || {
    echo -e "\e[1;31m[证书] 检测到多个私钥文件，请只保留一份\e[0m"
    exit 1
  }

  if command -v openssl >/dev/null 2>&1; then
    openssl x509 -in "$WS_CERT_PATH" -noout >/dev/null 2>&1 || {
      echo -e "\e[1;31m[证书] 上传的证书无法解析\e[0m"
      exit 1
    }
    openssl pkey -in "$WS_KEY_PATH" -noout >/dev/null 2>&1 || {
      echo -e "\e[1;31m[证书] 上传的私钥无法解析或带有密码\e[0m"
      exit 1
    }
  fi

  CF_SSL_MODE="Full (strict)"
  echo -e "\e[1;32m[证书] 使用上传证书: $(basename "$WS_CERT_PATH")\e[0m"
  echo -e "\e[1;32m[证书] 使用上传私钥: $(basename "$WS_KEY_PATH")\e[0m"
}

case "$TLS_CERT_MODE" in
  self_signed)
    generate_self_signed_certificate
    WS_CERT_PATH="$SELF_CERT_PATH"
    WS_KEY_PATH="$SELF_KEY_PATH"
    CF_SSL_MODE="Full"
    ;;
  origin)
    scan_origin_certificate
    if { [ -n "$TUIC_PORT" ] && [ "$TUIC_PORT" != "0" ]; } || \
       { [ -n "$HY2_PORT" ] && [ "$HY2_PORT" != "0" ]; }; then
      generate_self_signed_certificate
    fi
    ;;
  *)
    echo -e "\e[1;31mTLS_CERT_MODE 只能填写 self_signed 或 origin\e[0m"
    exit 1
    ;;
esac

chmod 600 "$WS_KEY_PATH"
[ -s "$SELF_KEY_PATH" ] && chmod 600 "$SELF_KEY_PATH"

# 生成 sing-box 配置
INBOUNDS_JSON=""
add_inbound() {
  local item="$1"
  if [ -z "$INBOUNDS_JSON" ]; then
    INBOUNDS_JSON="$item"
  else
    INBOUNDS_JSON="${INBOUNDS_JSON},${item}"
  fi
}

[ -n "$TUIC_PORT" ] && [ "$TUIC_PORT" != "0" ] && add_inbound "$(cat <<EOF
{
  "type": "tuic",
  "listen": "::",
  "listen_port": $TUIC_PORT,
  "users": [{"uuid": "$UUID", "password": "admin"}],
  "congestion_control": "bbr",
  "tls": {
    "enabled": true,
    "alpn": ["h3"],
    "certificate_path": "$SELF_CERT_PATH",
    "key_path": "$SELF_KEY_PATH"
  }
}
EOF
)"

[ -n "$HY2_PORT" ] && [ "$HY2_PORT" != "0" ] && add_inbound "$(cat <<EOF
{
  "type": "hysteria2",
  "listen": "::",
  "listen_port": $HY2_PORT,
  "users": [{"password": "$UUID"}],
  "masquerade": "https://bing.com",
  "tls": {
    "enabled": true,
    "alpn": ["h3"],
    "certificate_path": "$SELF_CERT_PATH",
    "key_path": "$SELF_KEY_PATH"
  }
}
EOF
)"

[ -n "$REALITY_PORT" ] && [ "$REALITY_PORT" != "0" ] && add_inbound "$(cat <<EOF
{
  "type": "vless",
  "listen": "::",
  "listen_port": $REALITY_PORT,
  "users": [{"uuid": "$UUID", "flow": "xtls-rprx-vision"}],
  "tls": {
    "enabled": true,
    "server_name": "www.nazhumi.com",
    "reality": {
      "enabled": true,
      "handshake": {"server": "www.nazhumi.com", "server_port": 443},
      "private_key": "$private_key",
      "short_id": [""]
    }
  }
}
EOF
)"

[ -n "$WS_PORT" ] && [ "$WS_PORT" != "0" ] && [ -n "$CF_DOMAIN" ] && add_inbound "$(cat <<EOF
{
  "type": "vless",
  "listen": "0.0.0.0",
  "listen_port": $WS_PORT,
  "users": [{"uuid": "$UUID"}],
  "tls": {
    "enabled": true,
    "alpn": ["http/1.1"],
    "certificate_path": "$WS_CERT_PATH",
    "key_path": "$WS_KEY_PATH"
  },
  "transport": {
    "type": "ws",
    "path": "/vless-ws"
  }
}
EOF
)"

[ -n "$INBOUNDS_JSON" ] || {
  echo -e "\e[1;31m没有启用任何入站端口\e[0m"
  exit 1
}

cat > "${FILE_PATH}/config.json" <<EOF
{
  "log": {"level": "info", "timestamp": true},
  "inbounds": [
$INBOUNDS_JSON
  ],
  "outbounds": [{"type": "direct"}]
}
EOF

"${FILE_MAP[sing-box]}" check -c "${FILE_PATH}/config.json"
"${FILE_MAP[sing-box]}" run -c "${FILE_PATH}/config.json" &
SINGBOX_PID=$!
echo "[SING-BOX] 启动完成 PID=$SINGBOX_PID"
echo "[Cloudflare] Origin Rule: ${CF_DOMAIN}:443 → 源站端口 ${WS_PORT}"
echo "[Cloudflare] SSL/TLS 模式: ${CF_SSL_MODE}"

# 获取 IP 和 ISP
fetch_text() {
  curl -A "Mozilla/5.0" -H "Accept: */*" -s --max-time "$2" "$1" 2>/dev/null || true
}

json_get() {
  echo "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

join_isp() {
  local country="$1"
  local org="$2"
  if [ -n "$country" ] && [ -n "$org" ]; then
    echo "${country}-${org}"
  elif [ -n "$country" ]; then
    echo "$country"
  elif [ -n "$org" ]; then
    echo "$org"
  else
    echo ""
  fi
}

get_ip() {
  local ip
  ip=$(fetch_text "https://api.ipify.org" 2)
  [ -n "$ip" ] && echo "$ip" && return
  ip=$(fetch_text "https://ipv4.ip.sb" 2)
  [ -n "$ip" ] && echo "$ip" && return
  echo "IP_ERROR"
}

get_isp() {
  local data country org isp

  data=$(fetch_text "https://api.ip.sb/geoip" 5)
  if [ -n "$data" ]; then
    country=$(json_get "$data" "country_code")
    org=$(json_get "$data" "organization")
    [ -z "$org" ] && org=$(json_get "$data" "isp")
    [ -z "$org" ] && org=$(json_get "$data" "asn_organization")
    isp=$(join_isp "$country" "$org")
    [ -n "$isp" ] && echo "$isp" && return
  fi

  data=$(fetch_text "https://ipapi.co/json/" 5)
  if [ -n "$data" ]; then
    country=$(json_get "$data" "country_code")
    org=$(json_get "$data" "org")
    [ -z "$org" ] && org=$(json_get "$data" "asn")
    isp=$(join_isp "$country" "$org")
    [ -n "$isp" ] && echo "$isp" && return
  fi

  data=$(fetch_text "http://ip-api.com/json" 5)
  if [ -n "$data" ]; then
    country=$(json_get "$data" "countryCode")
    org=$(json_get "$data" "isp")
    [ -z "$org" ] && org=$(json_get "$data" "org")
    [ -z "$org" ] && org=$(json_get "$data" "as")
    isp=$(join_isp "$country" "$org")
    [ -n "$isp" ] && echo "$isp" && return
  fi

  echo "0.0"
}

IP=$(get_ip)
ISP=$(get_isp)

# 生成节点链接
LINKS=""
add_link() {
  local link="$1"
  LINKS="${LINKS}${link}
"
  echo "$link"
}

[ -n "$TUIC_PORT" ] && [ "$TUIC_PORT" != "0" ] && add_link "tuic://${UUID}:admin@${IP}:${TUIC_PORT}?sni=www.bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#TUIC-${ISP}"
[ -n "$HY2_PORT" ] && [ "$HY2_PORT" != "0" ] && add_link "hysteria2://${UUID}@${IP}:${HY2_PORT}/?sni=www.bing.com&insecure=1#Hysteria2-${ISP}"
[ -n "$REALITY_PORT" ] && [ "$REALITY_PORT" != "0" ] && add_link "vless://${UUID}@${IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.nazhumi.com&fp=firefox&pbk=${public_key}&type=tcp#Reality-${ISP}"

if [ -n "$WS_PORT" ] && [ "$WS_PORT" != "0" ] && [ -n "$CF_DOMAIN" ]; then
  CF_SERVER="$CF_DOMAIN"
  [ -n "$CF_PREFERRED_DOMAIN" ] && CF_SERVER="$CF_PREFERRED_DOMAIN"
  add_link "vless://${UUID}@${CF_SERVER}:${CF_PREFERRED_PORT}?encryption=none&security=tls&fp=chrome&type=ws&host=${CF_DOMAIN}&path=%2Fvless-ws&sni=${CF_DOMAIN}#VLESS-${ISP}"
fi

rm -f "${FILE_PATH}/sub.txt" 2>/dev/null || true

# Telegram 推送
send_telegram() {
  if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
    echo -e "\e[1;33m[TG] 未设置 BOT_TOKEN 或 CHAT_ID，跳过推送\e[0m"
    return
  fi

  if [ -z "$LINKS" ]; then
    echo -e "\e[1;33m[TG] 没有节点链接，跳过推送\e[0m"
    return
  fi

  local response
  response=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${ISP} 节点推送通知
${LINKS}" 2>/dev/null || true)

  if echo "$response" | grep -q '"ok":true'; then
    echo -e "\e[1;32m[TG] 节点配置已发送到 Telegram\e[0m"
  else
    echo -e "\e[1;31m[TG] Telegram 推送失败\e[0m"
  fi
}

send_telegram

# 每天北京时间 00:03 重启 sing-box
schedule_restart() {
  echo "[定时重启] 已启动（北京时间 00:03）"
  LAST_RESTART_DAY=-1

  while true; do
    now_ts=$(date +%s)
    beijing_ts=$((now_ts + 28800))
    H=$(( (beijing_ts / 3600) % 24 ))
    M=$(( (beijing_ts / 60) % 60 ))
    D=$(( beijing_ts / 86400 ))

    if [ "$H" -eq 0 ] && [ "$M" -eq 3 ] && [ "$D" -ne "$LAST_RESTART_DAY" ]; then
      LAST_RESTART_DAY=$D
      kill "$SINGBOX_PID" 2>/dev/null || true
      sleep 3
      "${FILE_MAP[sing-box]}" run -c "${FILE_PATH}/config.json" &
      SINGBOX_PID=$!
      echo "[定时重启] sing-box 重启完成 PID=$SINGBOX_PID"
    fi

    sleep 1
  done
}

schedule_restart
