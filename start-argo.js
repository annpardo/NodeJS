#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run') || process.env.DRY_RUN === 'true';
const NO_TELEGRAM = args.has('--no-telegram');

function envOr(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const TUIC_PORT = envOr('TUIC_PORT', '');
const HY2_PORT = envOr('HY2_PORT', '');
const REALITY_PORT = envOr('REALITY_PORT', '41579');
const ARGO_PORT = envOr('ARGO_PORT', '8080');
const ARGO_DOMAIN = envOr('ARGO_DOMAIN', '');
const ARGO_TOKEN = envOr('ARGO_TOKEN', '');
const ARGO_ENABLE = envOr('ARGO_ENABLE', 'true').toLowerCase() === 'true';
const CF_PREFERRED_DOMAIN = envOr('CF_PREFERRED_DOMAIN', envOr('PREFERRED_DOMAIN', ''));
const CF_PREFERRED_PORT = envOr('CF_PREFERRED_PORT', envOr('PREFERRED_PORT', '443'));
const CHAT_ID = envOr('CHAT_ID', '');
const BOT_TOKEN = envOr('BOT_TOKEN', '');

const scriptDir = __dirname;
process.chdir(scriptDir);
const filePath = path.join(process.cwd(), '.npm');
const uuidFile = path.join(filePath, 'uuid.txt');
const keyFile = path.join(filePath, 'key.txt');
const configPath = path.join(filePath, 'config.json');
const argoLog = path.join(filePath, 'bot.log');

let singBoxChild = null;
let argoChild = null;
let singBoxPid = null;
let argoPid = null;

function info(message) {
  console.log(message);
}

function warn(message) {
  console.warn(`[WARN] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir() {
  if (DRY_RUN) {
    info(`[DRY-RUN] mkdir -p ${filePath}`);
    return;
  }
  await fsp.mkdir(filePath, { recursive: true, mode: 0o700 });
}

function randomExecutableName() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(6);
  let result = '';
  for (const byte of bytes) result += alphabet[byte % alphabet.length];
  return result;
}

function baseUrlForArchitecture() {
  const arch = process.arch;
  if (arch === 'arm64' || arch.startsWith('arm')) return 'https://arm64.ssss.nyc.mn';
  if (arch === 'x64' || arch === 'amd64') return 'https://amd64.ssss.nyc.mn';
  if (arch === 's390x') return 'https://s390x.ssss.nyc.mn';
  throw new Error(`不支持的架构: ${arch}`);
}

async function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(filename));
  return hash.digest('hex');
}

async function downloadFile(url, filename, logicalName) {
  if (DRY_RUN) {
    info(`[DRY-RUN] download ${url} -> ${filename}`);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'start-argo-node/1.0' },
    });
    if (!response.ok) {
      throw new Error(`下载失败 ${response.status} ${response.statusText}: ${url}`);
    }

    if (response.body && typeof Readable.fromWeb === 'function') {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filename));
    } else {
      await fsp.writeFile(filename, Buffer.from(await response.arrayBuffer()));
    }
    await fsp.chmod(filename, 0o700);

    const expected = logicalName === 'sing-box'
      ? process.env.SING_BOX_SHA256
      : process.env.ARGO_SHA256;
    if (expected) {
      const actual = await sha256File(filename);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        await fsp.rm(filename, { force: true });
        throw new Error(`${logicalName} SHA-256 校验失败`);
      }
      info(`[校验] ${logicalName} SHA-256 通过`);
    } else {
      warn(`${logicalName} 未设置 SHA-256，原脚本也没有校验下载文件`);
    }
    info(`[下载] ${logicalName} 完成`);
  } finally {
    clearTimeout(timeout);
  }
}

async function getUuid() {
  if (!DRY_RUN && fs.existsSync(uuidFile)) {
    const uuid = (await fsp.readFile(uuidFile, 'utf8')).trim();
    if (uuid) {
      info(`[UUID] 复用固定 UUID: ${uuid}`);
      return uuid;
    }
  }

  if (DRY_RUN) {
    const uuid = '00000000-0000-4000-8000-000000000000';
    info(`[DRY-RUN] 使用示例 UUID: ${uuid}`);
    return uuid;
  }

  const uuid = crypto.randomUUID();
  await fsp.writeFile(uuidFile, `${uuid}\n`, { mode: 0o600 });
  await fsp.chmod(uuidFile, 0o600);
  info(`[UUID] 首次生成并保存: ${uuid}`);
  return uuid;
}

async function commandExists(command) {
  if (DRY_RUN) return true;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(probe, [command]);
    return true;
  } catch {
    return false;
  }
}

async function execForOutput(command, commandArgs) {
  if (DRY_RUN) {
    info(`[DRY-RUN] ${command} ${commandArgs.join(' ')}`);
    return '';
  }
  const result = await execFileAsync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return result.stdout || '';
}

function spawnManaged(command, commandArgs, options = {}) {
  if (DRY_RUN) {
    info(`[DRY-RUN] spawn ${command} ${commandArgs.join(' ')}`);
    return null;
  }

  const child = spawn(command, commandArgs, {
    cwd: process.cwd(),
    ...options,
  });
  child.on('error', (error) => {
    console.error(`[子进程错误] ${command}: ${error.message}`);
  });
  return child;
}

async function getRealityKeys(fileMap) {
  if (!DRY_RUN && fs.existsSync(keyFile)) {
    const content = await fsp.readFile(keyFile, 'utf8');
    const privateMatch = content.match(/^PrivateKey:\s*(\S+)/m);
    const publicMatch = content.match(/^PublicKey:\s*(\S+)/m);
    if (privateMatch && publicMatch) {
      info('[密钥] 检测到已有密钥，复用...');
      return { privateKey: privateMatch[1], publicKey: publicMatch[1] };
    }
    warn('key.txt 内容不完整，将重新生成');
  }

  if (DRY_RUN) {
    info('[DRY-RUN] 生成 Reality 密钥对');
    return {
      privateKey: 'DRY_RUN_PRIVATE_KEY',
      publicKey: 'DRY_RUN_PUBLIC_KEY',
    };
  }

  const output = await execForOutput(fileMap['sing-box'], ['generate', 'reality-keypair']);
  const privateMatch = output.match(/^PrivateKey:\s*(\S+)/m);
  const publicMatch = output.match(/^PublicKey:\s*(\S+)/m);
  if (!privateMatch || !publicMatch) {
    throw new Error('sing-box 没有返回预期的 Reality 密钥格式');
  }

  await fsp.writeFile(keyFile, output, { mode: 0o600 });
  await fsp.chmod(keyFile, 0o600);
  info('[密钥] 密钥已保存');
  return { privateKey: privateMatch[1], publicKey: publicMatch[1] };
}

async function generateCertificate() {
  const privateKeyPath = path.join(filePath, 'private.key');
  const certificatePath = path.join(filePath, 'cert.pem');

  if (DRY_RUN) {
    info(`[DRY-RUN] 生成自签名证书: ${certificatePath}`);
    return { privateKeyPath, certificatePath };
  }

  if (!(await commandExists('openssl'))) {
    throw new Error('未找到 openssl。为避免复用公开的硬编码私钥，请先安装 openssl。');
  }

  await execFileAsync('openssl', [
    'ecparam', '-genkey', '-name', 'prime256v1', '-out', privateKeyPath,
  ], { maxBuffer: 1024 * 1024 });
  await execFileAsync('openssl', [
    'req', '-new', '-x509', '-days', '3650', '-key', privateKeyPath,
    '-out', certificatePath, '-subj', '/CN=bing.com',
  ], { maxBuffer: 1024 * 1024 });
  await fsp.chmod(privateKeyPath, 0o600);
  info('[证书] 自签名证书生成完成');
  return { privateKeyPath, certificatePath };
}

function portOrNull(value, name) {
  if (value === '' || value === '0') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} 不是有效端口: ${value}`);
  }
  return port;
}

function buildConfig({ uuid, privateKey, certificatePath, privateKeyPath }) {
  const inbounds = [];
  const tuicPort = portOrNull(TUIC_PORT, 'TUIC_PORT');
  const hy2Port = portOrNull(HY2_PORT, 'HY2_PORT');
  const realityPort = portOrNull(REALITY_PORT, 'REALITY_PORT');
  const argoPort = portOrNull(ARGO_PORT, 'ARGO_PORT');

  if (tuicPort !== null) {
    inbounds.push({
      type: 'tuic',
      listen: '::',
      listen_port: tuicPort,
      users: [{ uuid, password: 'admin' }],
      congestion_control: 'bbr',
      tls: {
        enabled: true,
        alpn: ['h3'],
        certificate_path: certificatePath,
        key_path: privateKeyPath,
      },
    });
  }

  if (hy2Port !== null) {
    inbounds.push({
      type: 'hysteria2',
      listen: '::',
      listen_port: hy2Port,
      users: [{ password: uuid }],
      masquerade: 'https://bing.com',
      tls: {
        enabled: true,
        alpn: ['h3'],
        certificate_path: certificatePath,
        key_path: privateKeyPath,
      },
    });
  }

  if (realityPort !== null) {
    inbounds.push({
      type: 'vless',
      listen: '::',
      listen_port: realityPort,
      users: [{ uuid, flow: 'xtls-rprx-vision' }],
      tls: {
        enabled: true,
        server_name: 'www.nazhumi.com',
        reality: {
          enabled: true,
          handshake: { server: 'www.nazhumi.com', server_port: 443 },
          private_key: privateKey,
          short_id: [''],
        },
      },
    });
  }

  if (ARGO_ENABLE) {
    if (argoPort === null) throw new Error('ARGO_ENABLE=true 时 ARGO_PORT 不能为 0');
    inbounds.push({
      type: 'vless',
      listen: '127.0.0.1',
      listen_port: argoPort,
      users: [{ uuid }],
      transport: {
        type: 'ws',
        path: '/vless-ws',
        max_early_data: 2560,
        early_data_header_name: 'Sec-WebSocket-Protocol',
      },
    });
  }

  return {
    log: { disabled: true },
    inbounds,
    outbounds: [{ type: 'direct' }],
  };
}

async function writeConfig(config) {
  const content = `${JSON.stringify(config, null, 2)}\n`;
  if (DRY_RUN) {
    info('[DRY-RUN] 将生成以下 config.json:');
    console.log(content);
    return;
  }
  await fsp.writeFile(configPath, content, { mode: 0o600 });
  await fsp.chmod(configPath, 0o600);
  info(`[配置] 已写入 ${configPath}`);
}

async function startArgo(fileMap) {
  let argoHost = '';

  if (!ARGO_ENABLE) {
    info('[ARGO] 已禁用');
    return argoHost;
  }

  if (DRY_RUN) {
    argoHost = ARGO_TOKEN
      ? (ARGO_DOMAIN || '固定隧道域名.example.com')
      : 'dry-run.trycloudflare.com';
    info(`[DRY-RUN] Argo 计划启动，域名示例: ${argoHost}`);
    return argoHost;
  }

  await fsp.writeFile(argoLog, '');
  const logFd = fs.openSync(argoLog, 'a');

  if (ARGO_TOKEN) {
    argoChild = spawnManaged(fileMap.argo, [
      'tunnel', '--edge-ip-version', 'auto', '--protocol', 'http2',
      '--ha-connections', '4', '--no-autoupdate', 'run', '--token', ARGO_TOKEN,
    ], { stdio: ['ignore', logFd, logFd] });
    argoPid = argoChild ? argoChild.pid : null;
    argoHost = ARGO_DOMAIN;
    info(`[ARGO] 固定隧道启动完成 PID=${argoPid}`);
    if (!argoHost) info('[ARGO] 固定隧道需要设置 ARGO_DOMAIN 才能生成节点');
  } else {
    const argoPort = portOrNull(ARGO_PORT, 'ARGO_PORT');
    argoChild = spawnManaged(fileMap.argo, [
      'tunnel', '--edge-ip-version', 'auto', '--protocol', 'http2',
      '--url', `http://127.0.0.1:${argoPort}`, '--no-autoupdate',
    ], { stdio: ['ignore', logFd, logFd] });
    argoPid = argoChild ? argoChild.pid : null;
    info(`[ARGO] 临时隧道启动完成 PID=${argoPid}`);

    for (let i = 0; i < 20; i += 1) {
      await sleep(1000);
      let log = '';
      try {
        log = await fsp.readFile(argoLog, 'utf8');
      } catch {
      }
      const match = log.match(/https:\/\/[-a-zA-Z0-9.]*\.trycloudflare\.com/);
      if (match) {
        argoHost = match[0].replace(/^https:\/\//, '');
        break;
      }
    }
  }

  if (argoHost) info(`[ARGO] 域名: ${argoHost}`);
  else info(`[ARGO] 未获取到域名，请检查 ${argoLog}`);

  try { fs.closeSync(logFd); } catch {}
  return argoHost;
}

async function fetchText(url, timeoutMs) {
  if (DRY_RUN) {
    info(`[DRY-RUN] 跳过请求 ${url}`);
    return '';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: '*/*',
      },
      signal: controller.signal,
    });
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

function jsonGet(text, key) {
  try {
    const value = JSON.parse(text)[key];
    return value === undefined || value === null ? '' : String(value);
  } catch {
    return '';
  }
}

function joinIsp(country, org) {
  if (country && org) return `${country}-${org}`;
  return country || org || '';
}

async function getIp() {
  if (DRY_RUN) return '203.0.113.10';
  for (const url of ['https://api.ipify.org', 'https://ipv4.ip.sb']) {
    const ip = (await fetchText(url, 2000)).trim();
    if (ip) return ip;
  }
  return 'IP_ERROR';
}

async function getIsp() {
  if (DRY_RUN) return 'DRY-RUN';
  const providers = [
    {
      url: 'https://api.ip.sb/geoip',
      country: 'country_code',
      org: ['organization', 'isp', 'asn_organization'],
    },
    {
      url: 'https://ipapi.co/json/',
      country: 'country_code',
      org: ['org', 'asn'],
    },
    {
      url: 'http://ip-api.com/json',
      country: 'countryCode',
      org: ['isp', 'org', 'as'],
    },
  ];

  for (const provider of providers) {
    const data = await fetchText(provider.url, 5000);
    if (!data) continue;
    const country = jsonGet(data, provider.country);
    let org = '';
    for (const key of provider.org) {
      org = jsonGet(data, key);
      if (org) break;
    }
    const isp = joinIsp(country, org);
    if (isp) return isp;
  }
  return '0.0';
}

function makeLinks({ uuid, ip, isp, publicKey, argoHost }) {
  const links = [];
  const add = (link) => {
    links.push(link);
    console.log(link);
  };

  const tuicPort = portOrNull(TUIC_PORT, 'TUIC_PORT');
  const hy2Port = portOrNull(HY2_PORT, 'HY2_PORT');
  const realityPort = portOrNull(REALITY_PORT, 'REALITY_PORT');

  if (tuicPort !== null) {
    add(`tuic://${uuid}:admin@${ip}:${tuicPort}?sni=www.bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#TUIC-${isp}`);
  }
  if (hy2Port !== null) {
    add(`hysteria2://${uuid}@${ip}:${hy2Port}/?sni=www.bing.com&insecure=1#Hysteria2-${isp}`);
  }
  if (realityPort !== null) {
    add(`vless://${uuid}@${ip}:${realityPort}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.nazhumi.com&fp=firefox&pbk=${publicKey}&type=tcp#Reality-${isp}`);
  }

  if (argoHost) {
    const argoServer = CF_PREFERRED_DOMAIN || argoHost;
    const argoPort = CF_PREFERRED_PORT;
    add(`vless://${uuid}@${argoServer}:${argoPort}?encryption=none&security=tls&fp=chrome&type=ws&host=${argoHost}&path=/vless-ws%3Fed%3D2560&sni=${argoHost}#VLESS-${isp}`);
  }
  return links;
}

async function sendTelegram(links, isp) {
  if (NO_TELEGRAM || DRY_RUN) {
    info('[TG] 已跳过 Telegram（dry-run 或 --no-telegram）');
    return;
  }
  if (!BOT_TOKEN || !CHAT_ID) {
    info('[TG] 未设置 BOT_TOKEN 或 CHAT_ID，跳过推送');
    return;
  }
  if (!links.length) {
    info('[TG] 没有可发送的节点链接，跳过推送');
    return;
  }

  const localMessage = `${isp} 节点推送通知\n${links.join('\n')}`;
  const body = new URLSearchParams({ chat_id: CHAT_ID, text: localMessage });
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const result = await response.text();
    if (response.ok && /"ok"\s*:\s*true/.test(result)) {
      info('[TG] 节点配置已发送到 Telegram');
    } else {
      info('[TG] Telegram 推送失败');
      if (result) console.error(result);
    }
  } catch (error) {
    info(`[TG] Telegram 请求失败: ${error.message}`);
  }
}

function stopChild(child, label) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
    info(`[清理] 已停止 ${label}`);
  } catch (error) {
    warn(`停止 ${label} 失败: ${error.message}`);
  }
}

function installSignalHandlers() {
  if (DRY_RUN) return;
  const cleanup = (signal) => {
    stopChild(argoChild, 'argo');
    stopChild(singBoxChild, 'sing-box');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', () => cleanup('SIGINT'));
  process.once('SIGTERM', () => cleanup('SIGTERM'));
}

async function scheduleRestart(fileMap, configPathValue) {
  info('[定时重启:Sing-box] 已启动（北京时间 00:03）');
  let lastRestartDay = -1;

  while (true) {
    const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const hour = beijing.getUTCHours();
    const minute = beijing.getUTCMinutes();
    const day = Math.floor(beijing.getTime() / 86400000);

    if (hour === 0 && minute === 3 && day !== lastRestartDay) {
      info('[定时重启:Sing-box] 到达 00:03，重启 sing-box');
      lastRestartDay = day;
      stopChild(singBoxChild, 'sing-box');
      await sleep(3000);
      singBoxChild = spawnManaged(fileMap['sing-box'], ['run', '-c', configPathValue], { stdio: 'inherit' });
      singBoxPid = singBoxChild ? singBoxChild.pid : null;
      info(`[Sing-box 重启完成] 新 PID: ${singBoxPid}`);
    }
    await sleep(1000);
  }
}

async function main() {
  info(DRY_RUN ? '[模式] dry-run：不会下载、启动进程或访问外部 API' : '[模式] 正常执行');
  await ensureDir();

  const uuid = await getUuid();
  const baseUrl = baseUrlForArchitecture();
  const fileInfos = [['sbx-1.13.13', 'sing-box']];
  if (ARGO_ENABLE) fileInfos.push(['bot', 'argo']);
  const fileMap = Object.create(null);

  for (const [remoteName, logicalName] of fileInfos) {
    const downloadUrl = /^https?:\/\//.test(remoteName)
      ? remoteName
      : `${baseUrl}/${remoteName}`;
    const filename = path.join(filePath, randomExecutableName());
    fileMap[logicalName] = filename;
    await downloadFile(downloadUrl, filename, logicalName);
  }

  const { privateKey, publicKey } = await getRealityKeys(fileMap);
  const { privateKeyPath, certificatePath } = await generateCertificate();
  const config = buildConfig({ uuid, privateKey, certificatePath, privateKeyPath });
  await writeConfig(config);

  singBoxChild = spawnManaged(fileMap['sing-box'], ['run', '-c', configPath], { stdio: 'inherit' });
  singBoxPid = singBoxChild ? singBoxChild.pid : null;
  info(`[SING-BOX] 启动完成 PID=${singBoxPid ?? 'dry-run'}`);

  const argoHost = await startArgo(fileMap);
  const ip = await getIp();
  const isp = await getIsp();
  info(`[网络] IP=${ip} ISP=${isp}`);

  const links = makeLinks({ uuid, ip, isp, publicKey, argoHost });
  await sendTelegram(links, isp);

  if (DRY_RUN) {
    info('[DRY-RUN] 检查完成；没有创建 .npm 文件，也没有启动任何外部程序。');
    return;
  }

  installSignalHandlers();
  setTimeout(async () => {
    try {
      await fsp.rm(argoLog, { force: true });
      info('[清理] 已删除 bot.log');
    } catch (error) {
      warn(`删除 bot.log 失败: ${error.message}`);
    }
  }, 20000).unref();

  await scheduleRestart(fileMap, configPath);
}

main().catch((error) => {
  console.error(`[失败] ${error.message}`);
  process.exitCode = 1;
});
