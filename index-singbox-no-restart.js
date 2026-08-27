#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const koffi = require('koffi');
const { execFileSync } = require('child_process');

// ======================== 环境变量定义 ========================
const ARGO_DOMAIN    = process.env.ARGO_DOMAIN    || '';         // argo固定隧道域名,留空即使用临时隧道
const ARGO_TOKEN     = process.env.ARGO_TOKEN     || '';         // argo固定隧道Token，留空即使用临时隧道
const ARGO_PORT      = process.env.ARGO_PORT      || '8080';     // argo模式本地WebSocket端口
const TUIC_PORT      = process.env.TUIC_PORT      || '';         // tuic端口，留空不启用
const HY2_PORT       = process.env.HY2_PORT       || '';         // hy2端口，留空不启用
const REALITY_PORT   = process.env.REALITY_PORT   || '';         // reality端口，留空不启用
const REALITY_SNI    = process.env.REALITY_SNI    || 'www.nazhumi.com'; // Reality握手SNI和目标域名
const CF_DOMAIN      = process.env.CF_DOMAIN      || '';         // CDN模式使用的自有域名
const CF_ORIGIN_PORT = process.env.CF_ORIGIN_PORT || '';         // CDN模式源站端口
const CF_MODE        = process.env.CF_MODE        || '';         // argo、cdn或留空关闭Cloudflare
const CHAT_ID        = process.env.CHAT_ID        || '';         // Telegram chat_id，与BOT_TOKEN同时设置才推送
const BOT_TOKEN      = process.env.BOT_TOKEN      || '';         // Telegram bot_token，与CHAT_ID同时设置才推送
const UUID           = process.env.UUID           || '';         // 手动设置 UUID，必须为有效 RFC 4122 UUID
// ==============================================================

const argoPort = Number(ARGO_PORT.trim());
const cfMode = CF_MODE.trim().toLowerCase();

function log(...args) {
  console.log(...args);
}

function openHttpResponse(url, options = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) return reject(new Error(`Too many redirects: ${url}`));
        const redirectUrl = new URL(response.headers.location, target).toString();
        return openHttpResponse(redirectUrl, options, redirects - 1).then(resolve, reject);
      }
      resolve(response);
    });
    request.setTimeout(options.timeout || 10000, () => request.destroy(new Error(`Request timed out: ${url}`)));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function requestText(url, options = {}) {
  const response = await openHttpResponse(url, options);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`HTTP ${response.statusCode} from ${url}: ${body.slice(0, 200)}`);
  }
  return body;
}

async function requestJson(url, options = {}) {
  return JSON.parse(await requestText(url, options));
}

const runtimeFilePath = path.resolve(__dirname, '.npm');
const libraryDir = runtimeFilePath;
const singBoxConfigPath = path.resolve(runtimeFilePath, 'config.json');
const bootLogPath = path.resolve(runtimeFilePath, 'boot.log');
const keypairPath = path.resolve(runtimeFilePath, 'keypair.properties');
const subPath = path.resolve(runtimeFilePath, 'sub.txt');
const certPath = path.resolve(runtimeFilePath, 'cert.pem');
const tlsKeyPath = path.resolve(runtimeFilePath, 'private.key');
const temporaryDirectoryPath = path.resolve(__dirname, '.tmp');

const arch = (() => {
  const a = os.arch().toLowerCase();
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  if (a === 'x64' || a === 'amd64') return 'amd64';
  throw new Error(`Unsupported architecture for native libraries: ${a}`);
})();

let privateKey = '';
let publicKey = '';

// ======================== 辅助函数 ========================

function isValidPort(port) {
  if (port === null || port === undefined || port === '') return false;
  if (typeof port === 'string' && port.trim() === '') return false;
  const portNum = Number(port);
  return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
}

function validateEnvironment() {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(UUID)) {
    throw new Error('UUID must be set manually as a valid RFC 4122 UUID');
  }
  const optionalPorts = [
    ['TUIC_PORT', TUIC_PORT], ['HY2_PORT', HY2_PORT], ['REALITY_PORT', REALITY_PORT]
  ];
  for (const [name, value] of optionalPorts) {
    if (value !== '' && !isValidPort(value)) throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  if (!['', 'argo', 'cdn'].includes(cfMode)) throw new Error('CF_MODE must be argo, cdn, or empty');
  if (cfMode === 'argo' && !isValidPort(argoPort)) throw new Error('ARGO_PORT must be an integer from 1 to 65535');
  if (cfMode === 'cdn') {
    if (!CF_DOMAIN) throw new Error('CF_DOMAIN is required when CF_MODE=cdn');
    if (!isValidPort(CF_ORIGIN_PORT)) throw new Error('CF_ORIGIN_PORT must be an integer from 1 to 65535 when CF_MODE=cdn');
  }
  if (REALITY_PORT && !REALITY_SNI) throw new Error('REALITY_SNI cannot be empty when Reality is enabled');
  if (CF_DOMAIN && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(CF_DOMAIN)) {
    throw new Error('CF_DOMAIN must be a valid hostname');
  }
}

// ======================== 文件清理 ========================

const pathsToDelete = [
  'boot.log', 'config.json', 'cert.pem', 'private.key',
  'sbx.so', 'bot.so', 'sbx.so.download', 'bot.so.download',
  'cert.pem.tmp', 'private.key.tmp'
];
function cleanupTemporaryDirectory() {
  try {
    fs.rmSync(temporaryDirectoryPath, { recursive: true, force: true });
  } catch (error) {
    log(`[清理] 删除 .tmp 目录失败: ${error.message}`);
  }
}

function cleanupOldFiles() {
  pathsToDelete.forEach(file => {
    const filePath = path.join(runtimeFilePath, file);
    try { fs.unlinkSync(filePath); } catch (error) {
      if (error.code !== 'ENOENT') log(`[清理] 删除旧文件 ${file} 失败: ${error.message}`);
    }
  });
  cleanupTemporaryDirectory();
}

function cleanupRuntimeFiles() {
  const keepFiles = new Set(['keypair.properties', 'sub.txt']);
  try {
    if (fs.existsSync(runtimeFilePath)) {
      for (const file of fs.readdirSync(runtimeFilePath)) {
        if (keepFiles.has(file)) continue;
        const filePath = path.resolve(runtimeFilePath, file);
        try {
          if (fs.statSync(filePath).isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
          else fs.unlinkSync(filePath);
        } catch (error) {
          if (error.code !== 'ENOENT') log(`[清理] 删除 ${file} 失败: ${error.message}`);
        }
      }
    }
  } catch (error) {
    log(`[清理] 清理运行目录失败: ${error.message}`);
  }
  cleanupTemporaryDirectory();
  log('[清理] 已清理 .npm（保留 keypair.properties、sub.txt）及 .tmp 目录');
}

function scheduleRuntimeCleanup() {
  setTimeout(cleanupRuntimeFiles, 20000);
}

let consoleCleanupTimer = null;
function scheduleConsoleCleanup() {
  if (consoleCleanupTimer) clearTimeout(consoleCleanupTimer);
  consoleCleanupTimer = setTimeout(() => {
    consoleCleanupTimer = null;
    process.stdout.write('\x1Bc');
    console.log('Thank you for using this script, enjoy!');
  }, 45000);
}

// ======================== 下载库文件 ========================

async function isSharedLibrary(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return false;
    const littleEndian = header[5] === 1;
    const elfType = littleEndian ? header.readUInt16LE(16) : header.readUInt16BE(16);
    return elfType === 3; // ET_DYN
  } catch {
    return false;
  } finally {
    if (handle) await handle.close();
  }
}

async function downloadLibrary(url, fileName) {
  const target = path.resolve(libraryDir, fileName);
  if (fs.existsSync(target) && await isSharedLibrary(target)) {
    log(`[下载] 复用缓存: ${fileName}`);
    return target;
  }
  await fs.promises.mkdir(libraryDir, { recursive: true });
  const tmp = path.resolve(libraryDir, `${fileName}.download`);
  log(`[下载] 正在下载 ${fileName}: ${url}`);
  try {
    const response = await openHttpResponse(url, { timeout: 3 * 60 * 1000 });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw new Error(`HTTP ${response.statusCode} from ${url}`);
    }
    const writer = fs.createWriteStream(tmp, { mode: 0o600 });
    await pipeline(response, writer);
    if (!(await isSharedLibrary(tmp))) throw new Error(`Downloaded file is not an ELF shared library: ${url}`);
    try { await fs.promises.unlink(target); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.promises.rename(tmp, target);
    log(`[下载] ${fileName} 下载完成`);
  } catch (error) {
    try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
    throw error;
  }
  return target;
}

// ======================== Koffi 服务管理 ========================

function createService(name, libraryPath, startSymbol, stopSymbol, payload) {
  const lib = koffi.load(libraryPath);
  const startFn = lib.func(`int ${startSymbol}(str)`);
  const stopFn = lib.func(`int ${stopSymbol}()`);
  const label = name === 'sing-box' ? 'SING-BOX' : 'ARGO';
  let active = false;
  let operation = Promise.resolve();

  function start(nextPayload = payload) {
    if (active) return;
    active = true;
    try {
      startFn.async(nextPayload || '', (err, code) => {
        if (err) {
          active = false;
          log(`[${label}] 运行失败: ${err.message}`);
        } else if (code !== 0) {
          active = false;
          log(`[${label}] 已退出，退出码=${code}`);
        }
      });
    } catch (error) {
      active = false;
      throw error;
    }
  }

  function stop() {
    if (!active) return Promise.resolve();
    active = false;
    return new Promise(resolve => {
      try {
        stopFn.async(err => {
          if (err) {
            log(`[${label}] 停止失败: ${err.message}`);
          }
          resolve();
        });
      } catch (error) {
        log(`[${label}] 停止失败: ${error.message}`);
        resolve();
      }
    });
  }

  function enqueue(task) {
    operation = operation.then(task, task);
    return operation;
  }

  return {
    start: nextPayload => enqueue(() => start(nextPayload)),
    stop: () => enqueue(stop),
    isActive: () => active,
    library: lib
  };
}

// ======================== Reality X25519 密钥对 (纯JS) ========================

const _X25519_P = (1n << 255n) - 19n;
const _X25519_A24 = 121665n;

function _clampScalar(buf) {
  buf[0] &= 248;
  buf[31] &= 127;
  buf[31] |= 64;
}

function _mod(value) {
  value = ((value % _X25519_P) + _X25519_P) % _X25519_P;
  return value;
}

function _decodeLE(buf) {
  let result = 0n;
  for (let i = buf.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[i]);
  }
  return result;
}

function _encodeLE(value) {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return buf;
}

function _x25519(scalar, u) {
  let x1 = _decodeLE(u);
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n;
  let swap = 0;
  for (let t = 254; t >= 0; t--) {
    const byteIdx = Math.floor(t / 8);
    const kt = ((scalar[byteIdx] & 0xff) >> (t % 8)) & 1;
    swap ^= kt;
    if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
    swap = kt;
    const a = _mod(x2 + z2);
    const aa = _mod(a * a);
    const b = _mod(x2 - z2 + _X25519_P);
    const bb = _mod(b * b);
    const e = _mod(aa - bb + _X25519_P);
    const c = _mod(x3 + z3);
    const d = _mod(x3 - z3 + _X25519_P);
    const da = _mod(d * a);
    const cb = _mod(c * b);
    x3 = _mod((da + cb) * (da + cb));
    z3 = _mod(x1 * _mod((da - cb + _X25519_P) * (da - cb + _X25519_P)));
    x2 = _mod(aa * bb);
    z2 = _mod(e * _mod(aa + _X25519_A24 * e));
  }
  if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
  const z2inv = _modPow(z2, _X25519_P - 2n, _X25519_P);
  return _encodeLE(_mod(x2 * z2inv));
}

function _modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function generateRealityKeyPair() {
  const privateBytes = crypto.randomBytes(32);
  _clampScalar(privateBytes);
  const basepoint = Buffer.alloc(32);
  basepoint[0] = 9;
  const publicBytes = _x25519(privateBytes, basepoint);
  return {
    privateKey: privateBytes.toString('base64url'),
    publicKey: publicBytes.toString('base64url')
  };
}

function generateOrLoadKeyPair() {
  if (fs.existsSync(keypairPath)) {
    const content = fs.readFileSync(keypairPath, 'utf8');
    const privateKeyMatch = content.match(/PrivateKey:\s*(.*)/);
    const publicKeyMatch = content.match(/PublicKey:\s*(.*)/);
    if (privateKeyMatch && publicKeyMatch) {
      privateKey = privateKeyMatch[1];
      publicKey = publicKeyMatch[1];
      log('[密钥] 检测到已有 Reality 密钥，复用');
      log(`[密钥] PublicKey: ${publicKey}`);
      return;
    }
  }
  const pair = generateRealityKeyPair();
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  fs.writeFileSync(keypairPath, `PrivateKey: ${privateKey}\nPublicKey: ${publicKey}\n`, { mode: 0o600 });
  log('[密钥] 首次生成 Reality 密钥对并保存');
  log(`[密钥] PublicKey: ${publicKey}`);
}

// ======================== TLS 证书 ========================

const FALLBACK_EC_KEY =
  '-----BEGIN EC PARAMETERS-----\n' +
  'BggqhkjOPQMBBw==\n' +
  '-----END EC PARAMETERS-----\n' +
  '-----BEGIN EC PRIVATE KEY-----\n' +
  'MHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/++siNnfBYsdUYoAoGCCqGSM49\n' +
  'AwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASANnngZreoQDF16ARa\n' +
  '/TsyLyFoPkhLxSbehH/NBEjHtSZGaDhMqQ==\n' +
  '-----END EC PRIVATE KEY-----\n';

const FALLBACK_CERT =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBejCCASGgAwIBAgIUfWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw\n' +
  'EzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwOTE4MTgyMDIyWhcNMzUwOTE2MTgy\n' +
  'MDIyWjATMREwDwYDVQQDDAhiaW5nLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEH\n' +
  'A0IABNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdegEWv07Mi8h\n' +
  'aD5IS8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBBTV1cFID7UISE7PLTBR\n' +
  'BfGbgkrMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgkrMNzAPBgNVHRMB\n' +
  'Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAIDAJvg0vd/ytrQVvEcSm6XTlB+\n' +
  'eQ6OFb9LbLYL9f+sAiAffoMbi4y/0YUSlTtz7as9S8/lciBF5VCUoVIKS+vX2g==\n' +
  '-----END CERTIFICATE-----\n';

function ensureTlsCertificates(certPath, keyPath) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const privateKeyObject = crypto.createPrivateKey(fs.readFileSync(keyPath));
      const certificate = new crypto.X509Certificate(fs.readFileSync(certPath));
      const privatePublicKey = crypto.createPublicKey(privateKeyObject).export({ type: 'spki', format: 'der' });
      const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
      if (privatePublicKey.equals(certificatePublicKey)) return;
    } catch { /* replace invalid or mismatched TLS files */ }
    try { fs.unlinkSync(certPath); } catch { /* ignore */ }
    try { fs.unlinkSync(keyPath); } catch { /* ignore */ }
  }
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    execFileSync('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-out', keyPath], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-new', '-x509', '-days', '3650', '-key', keyPath, '-out', certPath, '-subj', '/CN=bing.com'], { stdio: 'ignore' });
    return;
    } catch { /* openssl not available */ }
  fs.writeFileSync(keyPath, FALLBACK_EC_KEY, { mode: 0o600 });
  fs.writeFileSync(certPath, FALLBACK_CERT, { mode: 0o644 });
}

// ======================== sing-box 配置生成 ========================

function generateSingBoxConfig(certPath, keyPath) {
  const inbounds = [];

  if (cfMode === 'argo') {
    inbounds.push({
      type: 'vless',
      tag: 'vless-ws-argo',
      listen: '127.0.0.1',
      listen_port: argoPort,
      users: [{ uuid: UUID }],
      transport: {
        type: 'ws',
        path: '/vless-ws',
        max_early_data: 2560,
        early_data_header_name: 'Sec-WebSocket-Protocol'
      }
    });
  } else if (cfMode === 'cdn') {
    inbounds.push({
      type: 'vless',
      tag: 'vless-ws-cdn',
      listen: '::',
      listen_port: Number(CF_ORIGIN_PORT),
      users: [{ uuid: UUID }],
      tls: {
        enabled: true,
        certificate_path: certPath,
        key_path: keyPath
      },
      transport: {
        type: 'ws',
        path: '/vless-ws',
        max_early_data: 2560,
        early_data_header_name: 'Sec-WebSocket-Protocol'
      }
    });
  }

  // Reality
  if (isValidPort(REALITY_PORT)) {
    inbounds.push({
      type: 'vless',
      tag: 'vless-reality',
      listen: '::',
      listen_port: parseInt(REALITY_PORT),
      users: [{ uuid: UUID, flow: 'xtls-rprx-vision' }],
      tls: {
        enabled: true,
        server_name: REALITY_SNI,
        reality: {
          enabled: true,
          handshake: { server: REALITY_SNI, server_port: 443 },
          private_key: privateKey,
          short_id: ['']
        }
      }
    });
  }

  // Hysteria2
  if (isValidPort(HY2_PORT)) {
    inbounds.push({
      type: 'hysteria2',
      tag: 'hysteria-in',
      listen: '::',
      listen_port: parseInt(HY2_PORT),
      users: [{ password: UUID }],
      masquerade: 'https://bing.com',
      tls: {
        enabled: true,
        alpn: ['h3'],
        certificate_path: certPath,
        key_path: keyPath
      }
    });
  }

  // TUIC
  if (isValidPort(TUIC_PORT)) {
    inbounds.push({
      type: 'tuic',
      tag: 'tuic-in',
      listen: '::',
      listen_port: parseInt(TUIC_PORT),
      users: [{ uuid: UUID, password: UUID }],
      congestion_control: 'bbr',
      tls: {
        enabled: true,
        alpn: ['h3'],
        certificate_path: certPath,
        key_path: keyPath
      }
    });
  }

  return {
    log: { disabled: true, level: 'error', timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }]
  };
}

// ======================== Cloudflared Payload ========================

function cloudflaredPayload() {
  if (ARGO_TOKEN) {
    return JSON.stringify({
      args: ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', ARGO_TOKEN]
    });
  }
  // Quick tunnel
  return JSON.stringify({
    args: [
      'tunnel', '--edge-ip-version', 'auto', '--no-autoupdate',
      '--protocol', 'http2', '--logfile', bootLogPath,
      '--loglevel', 'info', '--url', `http://localhost:${argoPort}`
    ]
  });
}

function singBoxPayload() {
  return JSON.stringify({ config: singBoxConfigPath, workingDir: '.', disableColor: true });
}

// ======================== 隧道域名检测 ========================

async function waitForQuickTunnelDomain(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        const matches = [...content.matchAll(/https:\/\/([A-Za-z0-9.-]+\.trycloudflare\.com)/g)];
        if (matches.length > 0) {
          return matches[matches.length - 1][1];
        }
      }
    } catch { /* file may not exist yet */ }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining)));
  }
  return null;
}

async function extractDomain() {
  if (cfMode === 'cdn') return CF_DOMAIN;
  if (cfMode !== 'argo') return null;
  if (ARGO_TOKEN) {
    if (ARGO_DOMAIN) {
      log(`[ARGO] 域名: ${ARGO_DOMAIN}`);
      return ARGO_DOMAIN;
    }
    log('[ARGO] 已设置 ARGO_TOKEN，但未设置 ARGO_DOMAIN，无法生成节点');
    return null;
  }
  // Quick tunnel
  log('[ARGO] 正在等待临时隧道域名');
  let domain = await waitForQuickTunnelDomain(bootLogPath, 30000);
  if (!domain) {
    log('[ARGO] 暂未获取域名，正在重试');
    try { fs.unlinkSync(bootLogPath); } catch { }
    await new Promise(r => setTimeout(r, 5000));
    domain = await waitForQuickTunnelDomain(bootLogPath, 30000);
  }
  if (domain) {
    log(`[ARGO] 域名: ${domain}`);
  } else {
    log('[ARGO] 未获取到临时隧道域名');
  }
  return domain;
}

// ======================== ISP 信息 ========================

async function getMetaInfo() {
  const providers = [
    ['https://api.ip.sb/geoip', data => [data.country_code, data.organization || data.isp || data.asn_organization]],
    ['https://ipapi.co/json/', data => [data.country_code, data.org || data.asn]],
    ['http://ip-api.com/json', data => [data.countryCode, data.isp || data.org || data.as]]
  ];
  for (const [url, select] of providers) {
    try {
      const data = await requestJson(url, {
        timeout: 5000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const [country, organization] = select(data || {});
      if (country || organization) {
        return [country, organization].filter(Boolean).join('-').replace(/\s+/g, '_');
      }
    } catch { /* try the next provider */ }
  }
  return 'Unknown';
}

async function getServerIp() {
  const providers = ['https://api.ipify.org', 'https://ipv4.ip.sb'];
  for (const url of providers) {
    try {
      const value = (await requestText(url, { timeout: 3000 })).trim();
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return value;
    } catch { /* try the next provider */ }
  }
  try {
    const value = (await requestText('https://ipv6.ip.sb', { timeout: 3000 })).trim();
    if (value.includes(':')) return `[${value}]`;
  } catch { /* no usable public address */ }
  return '';
}

// ======================== 节点链接生成 ========================

async function generateLinks(argoDomain) {
  const hasDirectNode = [TUIC_PORT, HY2_PORT, REALITY_PORT].some(isValidPort);
  const hasCloudflareNode = (cfMode === 'argo' || cfMode === 'cdn') && !!argoDomain;
  const SERVER_IP = hasDirectNode ? await getServerIp() : '';
  const ISP = (hasCloudflareNode || (hasDirectNode && SERVER_IP)) ? await getMetaInfo() : 'Unknown';
  const links = [];

  if (hasCloudflareNode) {
    links.push(`vless://${UUID}@${argoDomain}:443?encryption=none&security=tls&fp=chrome&type=ws&host=${argoDomain}&path=/vless-ws%3Fed%3D2560&sni=${argoDomain}#VLESS-${encodeURIComponent(ISP)}`);
  }

  if (!SERVER_IP && hasDirectNode) {
    log('[节点] 未获取到公网IP，已跳过直连节点');
  }
  if (SERVER_IP && isValidPort(TUIC_PORT)) {
    links.push(`tuic://${UUID}:${UUID}@${SERVER_IP}:${TUIC_PORT}?sni=www.bing.com&congestion_control=bbr&udp_relay_mode=native&alpn=h3&allow_insecure=1#TUIC-${encodeURIComponent(ISP)}`);
  }
  if (SERVER_IP && isValidPort(HY2_PORT)) {
    links.push(`hysteria2://${UUID}@${SERVER_IP}:${HY2_PORT}/?sni=www.bing.com&insecure=1&alpn=h3&obfs=none#Hysteria2-${encodeURIComponent(ISP)}`);
  }
  if (SERVER_IP && isValidPort(REALITY_PORT)) {
    links.push(`vless://${UUID}@${SERVER_IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${REALITY_SNI}&fp=firefox&pbk=${publicKey}&type=tcp&headerType=none#Reality-${encodeURIComponent(ISP)}`);
  }

  const linksText = links.join('\n');
  log('\x1b[32m' + linksText + '\x1b[0m');
  fs.writeFileSync(subPath, Buffer.from(linksText).toString('base64'), { mode: 0o600 });
  return { linksText, isp: ISP };
}

// ======================== Telegram 推送 ========================

async function sendTelegram(message, isp) {
  if (!BOT_TOKEN || !CHAT_ID) {
    log('[TG] 未设置 BOT_TOKEN 或 CHAT_ID，跳过推送');
    return;
  }
  try {
    if (!message.trim()) {
      log('[TG] 没有可发送的节点链接，跳过推送');
      return;
    }
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const params = {
      chat_id: CHAT_ID,
      text: `${isp} 节点推送通知\n${message}`
    };
    const body = new URLSearchParams(params).toString();
    await requestJson(url, {
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      body
    });
    log('[TG] 节点配置已发送到 Telegram');
  } catch (error) {
    log(`[TG] Telegram 推送失败: ${error.message}`);
  }
}

// ======================== 主流程 ========================

async function startServer() {
  validateEnvironment();

  // 1. 创建运行目录
  fs.mkdirSync(runtimeFilePath, { recursive: true });

  // 2. 清理一次性文件
  cleanupOldFiles();
  log(`[CF] 当前模式: ${cfMode || '关闭'}`);

  // 3. 下载 .so 库文件
  const baseUrl = `https://${arch}.oooen.com`;
  const singBoxLib = await downloadLibrary(`${baseUrl}/sbx.so`, 'sbx.so');
  let cloudflaredLib = null;

  if (cfMode === 'argo') {
    cloudflaredLib = await downloadLibrary(`${baseUrl}/bot.so`, 'bot.so');
  }

  // 4. 生成 Reality 密钥对
  if (REALITY_PORT) {
    generateOrLoadKeyPair();
  } else {
    log('[密钥] Reality 未启用，跳过 Reality 密钥生成');
  }

  // 5. 生成 TLS 证书
  const needsTls = !!(HY2_PORT || TUIC_PORT || cfMode === 'cdn');
  if (needsTls) {
    ensureTlsCertificates(certPath, tlsKeyPath);
  }

  // 6. 生成 sing-box config.json
  const writeSingBoxConfig = () => {
    const sbxConfig = generateSingBoxConfig(certPath, tlsKeyPath);
    fs.writeFileSync(singBoxConfigPath, JSON.stringify(sbxConfig, null, 2), { mode: 0o600 });
  };
  writeSingBoxConfig();

  // 7. 启动服务
  const services = [];

  // sing-box
  const singBoxService = createService('sing-box', singBoxLib, 'StartSingBox', 'StopSingBox', singBoxPayload());
  services.push(singBoxService);

  // cloudflared
  let cloudflaredService = null;
  if (cloudflaredLib) {
    const cfPayload = cloudflaredPayload();
    cloudflaredService = createService('cloudflared', cloudflaredLib, 'StartCloudflared', 'StopCloudflared', cfPayload);
    services.push(cloudflaredService);
  }

  let shuttingDown = false;
  const processLifetimeTimer = setInterval(() => {}, 3600000);

  async function stopAll(signal = 'shutdown') {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[停止] 收到 ${signal}，正在停止服务`);
    clearInterval(processLifetimeTimer);
    for (let i = services.length - 1; i >= 0; i--) {
      if (services[i] === cloudflaredService) continue;
      try { await services[i].stop(); } catch { }
    }
    process.exit(0);
  }
  process.once('SIGINT', () => stopAll('SIGINT'));
  process.once('SIGTERM', () => stopAll('SIGTERM'));
  process.once('SIGHUP', () => stopAll('SIGHUP'));

  for (const service of services) await service.start();
  await new Promise(r => setTimeout(r, 1000));
  if (!singBoxService.isActive()) throw new Error('Sing-box 原生服务在启动阶段退出');
  log('[SING-BOX] 启动完成');
  if (cloudflaredService) {
    log(ARGO_TOKEN ? '[ARGO] 固定隧道启动完成' : '[ARGO] 临时隧道启动完成');
  }

  // 8. 等待并检测隧道域名
  const argoDomain = await extractDomain();

  // 9. 生成节点链接并推送Telegram
  const { linksText, isp } = await generateLinks(argoDomain);
  await sendTelegram(linksText, isp);

  // 10. 20秒后清理运行目录，仅保留 Reality 密钥和订阅文件
  scheduleRuntimeCleanup();
  scheduleConsoleCleanup();
}

startServer().catch(error => {
  console.error('[启动失败]', error.stack || error.message);
  process.exit(1);
});
