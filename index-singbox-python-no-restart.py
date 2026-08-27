#!/usr/bin/env python3

# 导入基础模块
import os, sys, subprocess

# 强制安装依赖
subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "cryptography"])

# 导入其他依赖
import requests, re, ssl, json, time, base64, hashlib, secrets, shutil, signal, ctypes, threading
from typing import Optional
from ctypes import c_int, c_char_p
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import quote
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives import serialization

# ======================== 环境变量定义 ========================
ARGO_DOMAIN = os.environ.get('ARGO_DOMAIN', '')
ARGO_TOKEN = os.environ.get('ARGO_TOKEN', '')
ARGO_PORT = os.environ.get('ARGO_PORT', '8080')
TUIC_PORT = os.environ.get('TUIC_PORT', '')
HY2_PORT = os.environ.get('HY2_PORT', '')
REALITY_PORT = os.environ.get('REALITY_PORT', '')
REALITY_SNI = os.environ.get('REALITY_SNI', 'www.nazhumi.com')
CF_DOMAIN = os.environ.get('CF_DOMAIN', '')
CF_ORIGIN_PORT = os.environ.get('CF_ORIGIN_PORT', '')
CF_MODE = os.environ.get('CF_MODE', '').strip().lower()
CHAT_ID = os.environ.get('CHAT_ID', '')
BOT_TOKEN = os.environ.get('BOT_TOKEN', '')
UUID = os.environ.get('UUID', '')
# HTTP 保活/订阅服务保留这两个必要变量
PORT = int(os.environ.get('PORT', '3000'))
SUB_PATH = os.environ.get('SUB_PATH', 'sub')
# ==============================================================

# 控制日志输出
def log(*args, **kwargs):
    print(*args, **kwargs)

# 全局变量
ROOT = os.getcwd()
# sing-box 无重启版固定使用 .npm 保存运行时文件
FILE_PATH = '.npm'
runtimeFilePath = os.path.join(ROOT, FILE_PATH)
singBoxConfigPath = os.path.join(runtimeFilePath, 'config.json')
bootLogPath = os.path.join(runtimeFilePath, 'boot.log')
subPath = os.path.join(runtimeFilePath, 'sub.txt')
keypairPath = os.path.join(runtimeFilePath, 'keypair.properties')
subscribePath = '/' + SUB_PATH.lstrip('/')

privateKey = ''
publicKey = ''

def get_arch():
    machine = os.uname().machine.lower()
    if machine in ('arm64', 'aarch64'):
        return 'arm64'
    return 'amd64'

ARCH = get_arch()

# ======================== 辅助函数 ========================

def is_valid_port(port):
    try:
        if port is None or port == '':
            return False
        port_num = int(port)
        return 1 <= port_num <= 65535
    except (ValueError, TypeError):
        return False

def sha256_file(filepath):
    sha256_hash = hashlib.sha256()
    with open(filepath, 'rb') as f:
        for byte_block in iter(lambda: f.read(4096), b''):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()

# ======================== 文件清理 ========================

paths_to_delete = [
    'boot.log', 'config.json', 'cert.pem', 'private.key',
    'sbx.so', 'bot.so', 'sbx.so.download', 'bot.so.download',
    'cert.pem.tmp', 'private.key.tmp'
]

def cleanup_old_files():
    for file in paths_to_delete:
        filepath = os.path.join(FILE_PATH, file)
        try:
            if os.path.exists(filepath):
                os.unlink(filepath)
        except:
            pass

    # 与源代码一致，启动前删除原生组件可能留下的临时目录
    tmp_dir = os.path.join(ROOT, '.tmp')
    if os.path.exists(tmp_dir):
        try:
            shutil.rmtree(tmp_dir)
        except:
            pass
    
def cleanup_files(keep_sub=False):
    keep_files = set(['keypair.properties'])
    if keep_sub:
        keep_files.add('sub.txt')
    
    if os.path.exists(runtimeFilePath):
        try:
            for file in os.listdir(runtimeFilePath):
                if file in keep_files:
                    continue
                filepath = os.path.join(runtimeFilePath, file)
                try:
                    if os.path.isdir(filepath):
                        shutil.rmtree(filepath)
                    else:
                        os.unlink(filepath)
                except:
                    pass
        except Exception as e:
            log(f'Cleanup failed: {e}')
    
    tmp_dir = os.path.join(ROOT, '.tmp')
    if os.path.exists(tmp_dir):
        try:
            shutil.rmtree(tmp_dir)
        except:
            pass

def clear_console():
    os.system('clear' if os.name == 'posix' else 'cls')

# ======================== Argo 隧道配置 ========================

# ======================== 下载库文件 ========================

def download_library(url: str, filename: str, expected_sha256: str = None) -> str:
    target = os.path.join(runtimeFilePath, filename)
    
    if os.path.exists(target):
        if expected_sha256 is None or sha256_file(target) == expected_sha256:
            log(f'[下载] 使用已缓存的 {filename}')
            return target
    
    os.makedirs(runtimeFilePath, exist_ok=True)
    tmp = os.path.join(runtimeFilePath, f'{filename}.download')
    
    log(f'[下载] 正在下载 {filename}: {url}')
    
    response = requests.get(url, stream=True, timeout=180)
    response.raise_for_status()
    
    with open(tmp, 'wb') as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
    
    if expected_sha256 and sha256_file(tmp) != expected_sha256:
        raise Exception(f"SHA-256 mismatch for {tmp}")
    
    os.rename(tmp, target)
    os.chmod(target, 0o755)
    log(f'[下载] {filename} 下载完成')
    return target

def cloudflared_payload():
    if CF_MODE != 'argo':
        return None
    if ARGO_TOKEN:
        return json.dumps({'args': [
            'tunnel', '--edge-ip-version', 'auto', '--no-autoupdate',
            '--protocol', 'http2', 'run', '--token', ARGO_TOKEN
        ]})
    return json.dumps({
        'args': [
            'tunnel', '--edge-ip-version', 'auto', '--no-autoupdate',
            '--protocol', 'http2', '--logfile', bootLogPath,
            '--loglevel', 'info', '--url', f'http://localhost:{ARGO_PORT}'
        ]
    })

def singbox_payload():
    return json.dumps({'config': singBoxConfigPath, 'workingDir': '.', 'disableColor': True})

# ======================== 动态库加载 =========================

class NativeService:
    def __init__(self, name: str, lib_path: str, start_symbol: str, stop_symbol: str, payload: str):
        self.name = name
        self.lib_path = lib_path
        self.start_symbol = start_symbol
        self.stop_symbol = stop_symbol
        self.payload = payload
        self.lib = None
        self._stop_func = None
        self._running = False
    
    def start(self):
        """启动服务 - 在新线程中调用StartXXX函数"""
        try:
            # 加载动态库
            self.lib = ctypes.CDLL(self.lib_path)
            
            # 获取start函数
            start_func = getattr(self.lib, self.start_symbol)
            # 设置参数类型：const char*
            start_func.argtypes = [c_char_p]
            start_func.restype = c_int
            
            # 获取stop函数
            self._stop_func = getattr(self.lib, self.stop_symbol)
            self._stop_func.argtypes = []
            self._stop_func.restype = c_int
            
            # 在新线程中调用start函数（模拟异步）
            def run():
                try:
                    result = start_func(self.payload.encode('utf-8'))
                    if result != 0:
                        log(f"{self.name} native service exited with code {result}")
                except Exception as e:
                    log(f"{self.name} native service failed: {e}")
            
            thread = threading.Thread(target=run, daemon=True, name=f"{self.name}-thread")
            thread.start()
            self._running = True
            # print(f"{self.name} started")
            
        except Exception as e:
            log(f"Failed to start {self.name}: {e}")
            raise
    
    def stop(self):
        """停止服务"""
        if not self._running or self._stop_func is None:
            return
        
        try:
            result = self._stop_func()
            self._running = False
            log(f"{self.name} stopped with code {result}")
        except Exception as e:
            log(f"Failed to stop {self.name}: {e}")

# ======================== Reality X25519 密钥对 ========================

def clamp_x25519_private_key(private_key: bytes) -> bytes:
    if len(private_key) != 32:
        raise ValueError('X25519 private key must be 32 bytes')
    key = bytearray(private_key)
    key[0] &= 248
    key[31] &= 127
    key[31] |= 64
    return bytes(key)

def base64url_no_padding(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip('=')

def decode_base64url_no_padding(value: str) -> bytes:
    value = value.strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('invalid base64url value')
    padding = '=' * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + padding)

def x25519_pure_python(private_key: bytes, public_key: bytes) -> bytes:
    P = 2**255 - 19
    A24 = 121665
    
    def decode_scalar(k):
        return clamp_x25519_private_key(k)
    
    def decode_int(s):
        return sum(s[i] << (8 * i) for i in range(32))
    
    def encode_int(n):
        return bytes((n >> (8 * i)) & 0xff for i in range(32))
    
    def cswap(swap, x2, x3):
        dummy = swap * (x2 - x3)
        x2 -= dummy
        x3 += dummy
        return x2, x3
    
    k = decode_scalar(private_key)
    u = decode_int(public_key)
    
    x1 = u
    x2 = 1
    z2 = 0
    x3 = x1
    z3 = 1
    swap = 0
    
    for t in range(254, -1, -1):
        k_t = (k[t // 8] >> (t % 8)) & 1
        swap ^= k_t
        x2, x3 = cswap(swap, x2, x3)
        z2, z3 = cswap(swap, z2, z3)
        swap = k_t
        
        A = (x2 + z2) % P
        AA = (A * A) % P
        B = (x2 - z2) % P
        BB = (B * B) % P
        E = (AA - BB) % P
        C = (x3 + z3) % P
        D = (x3 - z3) % P
        DA = (D * A) % P
        CB = (C * B) % P
        x3 = ((DA + CB) * (DA + CB)) % P
        z3 = (x1 * ((DA - CB) * (DA - CB) % P)) % P
        x2 = (AA * BB) % P
        z2 = (E * ((AA + (A24 * E) % P) % P)) % P
    
    x2, x3 = cswap(swap, x2, x3)
    z2, z3 = cswap(swap, z2, z3)
    
    inv_z2 = pow(z2, P-2, P)
    result = (x2 * inv_z2) % P
    
    return encode_int(result)

def derive_x25519_public_key(private_key_bytes: bytes) -> bytes:
    private_key_bytes = clamp_x25519_private_key(private_key_bytes)
    private_key = x25519.X25519PrivateKey.from_private_bytes(private_key_bytes)
    return private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw
    )

def generate_reality_keypair():
    private_bytes = clamp_x25519_private_key(secrets.token_bytes(32))
    public_bytes = derive_x25519_public_key(private_bytes)
    return {
        'privateKey': base64url_no_padding(private_bytes),
        'publicKey': base64url_no_padding(public_bytes)
    }

def write_keypair(private_key_value: str, public_key_value: str):
    os.makedirs(os.path.dirname(keypairPath), exist_ok=True)
    with open(keypairPath, 'w') as f:
        f.write(f'PrivateKey: {private_key_value}\nPublicKey: {public_key_value}\n')

def generate_or_load_keypair():
    global privateKey, publicKey
    
    if os.path.exists(keypairPath):
        with open(keypairPath, 'r') as f:
            content = f.read()
        private_match = re.search(r'PrivateKey:\s*(.*)', content)
        public_match = re.search(r'PublicKey:\s*(.*)', content)
        if private_match and public_match:
            try:
                loaded_private = decode_base64url_no_padding(private_match.group(1))
                loaded_public = decode_base64url_no_padding(public_match.group(1))
                normalized_private = clamp_x25519_private_key(loaded_private)
                derived_public = derive_x25519_public_key(normalized_private)
                if len(loaded_public) != 32 or derived_public != loaded_public:
                    raise ValueError('stored public key does not match private key')
                privateKey = base64url_no_padding(normalized_private)
                publicKey = base64url_no_padding(derived_public)
                if privateKey != private_match.group(1).strip() or publicKey != public_match.group(1).strip():
                    write_keypair(privateKey, publicKey)
                log(f'Private Key: {privateKey}')
                log(f'Public Key: {publicKey}')
                return
            except Exception as e:
                log(f'Invalid Reality keypair, regenerating: {e}')
    
    pair = generate_reality_keypair()
    privateKey = pair['privateKey']
    publicKey = pair['publicKey']
    write_keypair(privateKey, publicKey)
    log(f'Private Key: {privateKey}')
    log(f'Public Key: {publicKey}')

# ======================== TLS 证书 ========================

FALLBACK_EC_KEY = '''-----BEGIN EC PARAMETERS-----
BggqhkjOPQMBBw==
-----END EC PARAMETERS-----
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/++siNnfBYsdUYoAoGCCqGSM49
AwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASANnngZreoQDF16ARa
/TsyLyFoPkhLxSbehH/NBEjHtSZGaDhMqQ==
-----END EC PRIVATE KEY-----
'''

FALLBACK_CERT = '''-----BEGIN CERTIFICATE-----
MIIBejCCASGgAwIBAgIUfWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwOTE4MTgyMDIyWhcNMzUwOTE2MTgy
MDIyWjATMREwDwYDVQQDDAhiaW5nLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdegEWv07Mi8h
aD5IS8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBBTV1cFID7UISE7PLTBR
BfGbgkrMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgkrMNzAPBgNVHRMB
Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAIDAJvg0vd/ytrQVvEcSm6XTlB+
eQ6OFb9LbLYL9f+sAiAffoMbi4y/0YUSlTtz7as9S8/lciBF5VCUoVIKS+vX2g==
-----END CERTIFICATE-----
'''

def ensure_tls_certificates(cert_path: str, key_path: str):
    if os.path.exists(cert_path) and os.path.exists(key_path) and tls_certificate_pair_is_valid(cert_path, key_path):
        return
    
    os.makedirs(os.path.dirname(cert_path), exist_ok=True)
    temp_cert_path = f'{cert_path}.tmp'
    temp_key_path = f'{key_path}.tmp'
    for temp_path in (temp_cert_path, temp_key_path):
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except:
            pass
    
    try:
        subprocess.run(['openssl', 'version'], capture_output=True, check=True)
        subprocess.run([
            'openssl', 'ecparam', '-genkey', '-name', 'prime256v1', '-out', temp_key_path
        ], capture_output=True, check=True)
        subprocess.run([
            'openssl', 'req', '-new', '-x509', '-days', '3650',
            '-key', temp_key_path, '-out', temp_cert_path, '-subj', '/CN=bing.com'
        ], capture_output=True, check=True)
        if tls_certificate_pair_is_valid(temp_cert_path, temp_key_path):
            os.replace(temp_cert_path, cert_path)
            os.replace(temp_key_path, key_path)
            return
    except:
        pass
    
    for temp_path in (temp_cert_path, temp_key_path):
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except:
            pass
    
    with open(key_path, 'w') as f:
        f.write(FALLBACK_EC_KEY)
    with open(cert_path, 'w') as f:
        f.write(FALLBACK_CERT)
    if not tls_certificate_pair_is_valid(cert_path, key_path):
        raise RuntimeError('failed to create a valid TLS certificate pair')

def tls_certificate_pair_is_valid(cert_path: str, key_path: str) -> bool:
    if not os.path.exists(cert_path) or not os.path.exists(key_path):
        return False
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=cert_path, keyfile=key_path)
        return True
    except Exception:
        return False

# ======================== sing-box 配置生成 ========================

def generate_singbox_config(cert_path: str, key_path: str) -> dict:
    inbounds = []

    if CF_MODE == 'argo':
        inbounds.append({
            'type': 'vless',
            'tag': 'vless-ws-argo',
            'listen': '127.0.0.1',
            'listen_port': int(ARGO_PORT),
            'users': [{'uuid': UUID}],
            'transport': {
                'type': 'ws',
                'path': '/vless-ws',
                'max_early_data': 2560,
                'early_data_header_name': 'Sec-WebSocket-Protocol'
            }
        })

    if CF_MODE == 'cdn' and is_valid_port(CF_ORIGIN_PORT):
        inbounds.append({
            'type': 'vless',
            'tag': 'vless-ws-cdn',
            'listen': '::',
            'listen_port': int(CF_ORIGIN_PORT),
            'users': [{'uuid': UUID}],
            'tls': {
                'enabled': True,
                'certificate_path': cert_path,
                'key_path': key_path
            },
            'transport': {
                'type': 'ws',
                'path': '/vless-ws',
                'max_early_data': 2560,
                'early_data_header_name': 'Sec-WebSocket-Protocol'
            }
        })
    
    if is_valid_port(REALITY_PORT):
        inbounds.append({
            'type': 'vless',
            'tag': 'vless-reality',
            'listen': '::',
            'listen_port': int(REALITY_PORT),
            'users': [{'uuid': UUID, 'flow': 'xtls-rprx-vision'}],
            'tls': {
                'enabled': True,
                    'server_name': REALITY_SNI,
                    'reality': {
                        'enabled': True,
                    'handshake': {'server': REALITY_SNI, 'server_port': 443},
                    'private_key': privateKey,
                    'short_id': ['']
                }
            }
        })
    
    if is_valid_port(HY2_PORT):
        inbounds.append({
            'type': 'hysteria2',
            'tag': 'hysteria-in',
            'listen': '::',
            'listen_port': int(HY2_PORT),
            'users': [{'password': UUID}],
            'masquerade': 'https://bing.com',
            'tls': {
                'enabled': True,
                'alpn': ['h3'],
                'certificate_path': cert_path,
                'key_path': key_path
            }
        })
    
    if is_valid_port(TUIC_PORT):
        inbounds.append({
            'type': 'tuic',
            'tag': 'tuic-in',
            'listen': '::',
            'listen_port': int(TUIC_PORT),
            'users': [{'uuid': UUID, 'password': UUID}],
            'congestion_control': 'bbr',
            'tls': {
                'enabled': True,
                'alpn': ['h3'],
                'certificate_path': cert_path,
                'key_path': key_path
            }
        })
    
    return {
        'log': {'disabled': True, 'level': 'error', 'timestamp': True},
        'inbounds': inbounds,
        'outbounds': [{'type': 'direct', 'tag': 'direct'}]
    }

# ======================== 隧道域名检测 ========================

def wait_for_quick_tunnel_domain(log_path: str, timeout_ms: int) -> Optional[str]:
    deadline = time.time() + timeout_ms / 1000
    last_content = ""
    
    while time.time() < deadline:
        try:
            if os.path.exists(log_path):
                with open(log_path, 'r') as f:
                    content = f.read()
                if content != last_content:
                    last_content = content
                    matches = re.findall(r'https://([A-Za-z0-9.-]+\.trycloudflare\.com)', content)
                    if matches:
                        return matches[-1]
        except:
            pass
        time.sleep(1)
    return None

def extract_domain() -> Optional[str]:
    if CF_MODE == 'cdn':
        return CF_DOMAIN or None
    if CF_MODE != 'argo':
        return None
    if ARGO_TOKEN and ARGO_DOMAIN:
        log(f'ARGO_DOMAIN: {ARGO_DOMAIN}')
        return ARGO_DOMAIN
    if ARGO_TOKEN and not ARGO_DOMAIN:
        log('ARGO_TOKEN 已设置，但未设置 ARGO_DOMAIN，无法生成节点')
        return None
    
    log('Waiting for quick tunnel domain in log...')
    domain = wait_for_quick_tunnel_domain(bootLogPath, 30000)
    if not domain:
        log('Quick tunnel domain not found, retrying...')
        try:
            os.unlink(bootLogPath)
        except:
            pass
        time.sleep(5)
        domain = wait_for_quick_tunnel_domain(bootLogPath, 30000)
    
    if domain:
        log(f'ArgoDomain: {domain}')
    else:
        log('ArgoDomain not found')
    return domain

# ======================== ISP 信息 ========================

def get_meta_info() -> str:
    try:
        response = requests.get('https://api.ip.sb/geoip', timeout=3)
        if response.status_code == 200:
            data = response.json()
            organization = data.get('organization') or data.get('isp') or data.get('asn_organization')
            if data.get('country_code') and organization:
                return f"{data['country_code']}-{organization}".replace(' ', '_')
    except:
        pass
    
    try:
        response = requests.get('http://ip-api.com/json', timeout=3)
        if response.status_code == 200:
            data = response.json()
            organization = data.get('isp') or data.get('org') or data.get('as')
            if data.get('status') == 'success' and data.get('countryCode') and organization:
                return f"{data['countryCode']}-{organization}".replace(' ', '_')
    except:
        pass
    
    return 'Unknown'

# ======================== 节点链接生成 ========================

def get_server_ip() -> str:
    try:
        response = requests.get('http://ipv4.ip.sb', timeout=3)
        if response.status_code == 200:
            return response.text.strip()
    except:
        pass
    
    try:
        result = subprocess.run(['curl', '-sm', '3', 'ipv4.ip.sb'], 
                                capture_output=True, text=True, timeout=5)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except:
        pass
    
    try:
        response = requests.get('http://ipv6.ip.sb', timeout=3)
        if response.status_code == 200:
            return f"[{response.text.strip()}]"
    except:
        pass
    
    try:
        result = subprocess.run(['curl', '-sm', '3', 'ipv6.ip.sb'],
                                capture_output=True, text=True, timeout=5)
        if result.returncode == 0 and result.stdout.strip():
            return f"[{result.stdout.strip()}]"
    except:
        pass
    
    return ""

def generate_links(argo_domain: Optional[str]) -> str:
    has_direct_node = any(is_valid_port(p) for p in (TUIC_PORT, HY2_PORT, REALITY_PORT))
    has_cloudflare_node = CF_MODE in ('argo', 'cdn') and bool(argo_domain)
    server_ip = get_server_ip() if has_direct_node else ''
    isp = get_meta_info() if (has_cloudflare_node or (has_direct_node and server_ip)) else 'Unknown'
    links = []

    if has_cloudflare_node:
        links.append(f'vless://{UUID}@{argo_domain}:443?encryption=none&security=tls&fp=chrome&type=ws&host={argo_domain}&path=/vless-ws%3Fed%3D2560&sni={argo_domain}#VLESS-{quote(isp)}')
    elif CF_MODE in ('argo', 'cdn'):
        log('[节点] 未获取到 Cloudflare 域名，已跳过 VLESS 节点')
    if has_direct_node and not server_ip:
        log('[节点] 未获取到公网IP，已跳过直连节点')
    if server_ip and is_valid_port(TUIC_PORT):
        links.append(f'tuic://{UUID}:{UUID}@{server_ip}:{TUIC_PORT}?sni=www.bing.com&congestion_control=bbr&udp_relay_mode=native&alpn=h3&allow_insecure=1#TUIC-{quote(isp)}')
    if server_ip and is_valid_port(HY2_PORT):
        links.append(f'hysteria2://{UUID}@{server_ip}:{HY2_PORT}/?sni=www.bing.com&insecure=1&alpn=h3&obfs=none#Hysteria2-{quote(isp)}')
    if server_ip and is_valid_port(REALITY_PORT):
        links.append(f'vless://{UUID}@{server_ip}:{REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni={REALITY_SNI}&fp=firefox&pbk={publicKey}&type=tcp&headerType=none#Reality-{quote(isp)}')

    sub_txt = '\n'.join(links)
    log(f'\033[32m{sub_txt}\033[0m')
    with open(subPath, 'w') as f:
        f.write(base64.b64encode(sub_txt.encode()).decode())
    log(f'{FILE_PATH}/sub.txt saved successfully')
    return sub_txt

# ======================== Telegram 推送 ========================

def send_telegram(message: str, isp: str = 'Unknown'):
    if not BOT_TOKEN or not CHAT_ID:
        log('[TG] 未设置 BOT_TOKEN 或 CHAT_ID，跳过推送')
        return
    
    try:
        if not message.strip():
            log('[TG] 没有可发送的节点链接，跳过推送')
            return
        text = f'{isp} 节点推送通知\n{message}'
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        params = {
            'chat_id': CHAT_ID,
            'text': text,
        }
        requests.post(url, data=params, timeout=30)
        log('[TG] 节点配置已发送到 Telegram')
    except Exception as error:
        log(f'[TG] Telegram 推送失败: {error}')

# ======================== HTTP 服务器 ========================

class SubscriptionHandler(BaseHTTPRequestHandler):
    sub_content = ""

    def do_GET(self):
        if self.path == subscribePath:
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            encoded = base64.b64encode(self.sub_content.encode()).decode()
            self.wfile.write(encoded.encode())
        elif self.path == '/':
            try:
                with open('index.html', 'r', encoding='utf-8') as f:
                    html_content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers()
                self.wfile.write(html_content.encode('utf-8'))
            except Exception:
                fallback_html = f'Hello world!<br><br>You can access /{SUB_PATH}(Default: /sub) get your nodes!'
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers()
                self.wfile.write(fallback_html.encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'Not Found')

    def log_message(self, format, *args):
        pass

def start_http_server(sub_txt: str, port: int):
    SubscriptionHandler.sub_content = sub_txt
    try:
        server = HTTPServer(('0.0.0.0', port), SubscriptionHandler)
        log(f'[HTTP] 订阅服务已启动，端口: {PORT}')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server
    except OSError as e:
        if e.errno == 98:  # Address already in use
            raise Exception(f'Port {port} is already in use.') from e
        else:
            raise

# ======================== 主流程 ========================

def start_server():
    global privateKey, publicKey

    log(f'[CF] 当前模式: {CF_MODE or "关闭"}')

    # 创建运行目录并清理上次运行留下的一次性文件
    if not os.path.exists(FILE_PATH):
        os.makedirs(FILE_PATH)
        log(f'{FILE_PATH} is created')
    cleanup_old_files()

    # 下载原生库
    base_url = f'https://{ARCH}.oooen.com'
    singbox_lib = download_library(f'{base_url}/sbx.so', 'sbx.so')
    cloudflared_lib = None
    if CF_MODE == 'argo':
        cloudflared_lib = download_library(f'{base_url}/bot.so', 'bot.so')

    # Reality 密钥只在启用 Reality 时读取或生成
    if is_valid_port(REALITY_PORT):
        generate_or_load_keypair()

    # CDN、Hysteria2、TUIC 需要 TLS 证书
    cert_path = os.path.join(runtimeFilePath, 'cert.pem')
    key_path = os.path.join(runtimeFilePath, 'private.key')
    needs_tls = CF_MODE == 'cdn' or is_valid_port(HY2_PORT) or is_valid_port(TUIC_PORT)
    if needs_tls:
        ensure_tls_certificates(cert_path, key_path)

    # 生成 sing-box 配置
    sbx_config = generate_singbox_config(cert_path, key_path)
    with open(singBoxConfigPath, 'w') as f:
        json.dump(sbx_config, f, indent=2)

    # 创建并启动原生服务
    services = []
    singbox_service = NativeService(
        'sing-box', singbox_lib,
        'StartSingBox', 'StopSingBox',
        singbox_payload()
    )
    services.append(singbox_service)
    cloudflared_service = None
    if cloudflared_lib:
        cf_payload = cloudflared_payload()
        if cf_payload:
            cloudflared_service = NativeService(
                'cloudflared', cloudflared_lib,
                'StartCloudflared', 'StopCloudflared',
                cf_payload
            )
            services.append(cloudflared_service)

    # 信号处理
    def stop_all():
        log('\n[停止] 正在停止服务')
        for service in reversed(services):
            try:
                service.stop()
            except:
                pass
        sys.exit(0)
    
    signal.signal(signal.SIGINT, lambda s, f: stop_all())
    signal.signal(signal.SIGTERM, lambda s, f: stop_all())
    
    # 启动所有服务
    for service in services:
        service.start()

    time.sleep(1)
    log('[SING-BOX] 启动完成')
    if cloudflared_service:
        log('[ARGO] 临时隧道启动完成')

    # 等待并检测 Argo 域名
    argo_domain = extract_domain()

    # 生成原始节点链接，并把 Base64 内容写入 sub.txt
    sub_txt = generate_links(argo_domain)
    http_server = start_http_server(sub_txt, PORT)
    send_telegram(sub_txt)

    # 20 秒后清理运行文件，保留 keypair.properties 和 sub.txt
    def delayed_cleanup():
        time.sleep(20)
        cleanup_files(keep_sub=True)
        clear_console()
        print('谢谢使用')

    cleanup_thread = threading.Thread(target=delayed_cleanup, daemon=True)
    cleanup_thread.start()

    # 保持主线程运行
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        stop_all()
        if http_server:
            http_server.shutdown()

if __name__ == '__main__':
    start_server()
