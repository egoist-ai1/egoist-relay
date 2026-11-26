import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

const STARTUP_TIMEOUT_MS = 5000;
// TCP к MTProxy идёт через SOCKS туннеля (хэндшейк + дорога до сервера); одна попытка укладывается в клиентский дедлайн моста (5 с)
const CONNECT_TIMEOUT_MS = 4000;
const MAX_MTPROXY_LINK_LENGTH = 2048;
const HANDSHAKE_TIMEOUT_MS = 8000;
const FIRST_RESPONSE_TIMEOUT_MS = 12000;
const LOCAL_FIRST_RESPONSE_TIMEOUT_MS = 45000;
const HEARTBEAT_INTERVAL_MS = 20000;
const BACKPRESSURE_TIMEOUT_MS = 20000;
const MAX_SETTINGS_BYTES = 8192;
const MAX_CONNECTIONS = 128;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;
const HEADER_BYTES = 64;
const PROTO_TAG = 0xefefefef;
// Публичные стартовые IPv4 Telegram Desktop. В SOCKS отправляется IP, поэтому DNS для DC не нужен.
const TELEGRAM_DC_ADDRESSES = [
  '149.154.175.50', '149.154.167.51', '149.154.175.100', '149.154.167.91', '149.154.171.5',
];
const ORIGINS = new Set([
  'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost', 'http://localhost:1234',
]);
const FORBIDDEN_PREFIXES = new Set(['48454144', '504f5354', '47455420', '4f505449', '16030102', 'dddddddd', 'eeeeeeee']);

/** Ошибка с кодом: код уходит в stderr воркера и в журнал оболочки, секретов в нём нет. */
function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function createTelegramTransport({
  token, origins, port = 0, socksPort, mtproxy, localPort, localSecret, nativeSocksPort, standaloneSocksPort, standaloneMtproxy,
}) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)
    || !Array.isArray(origins) || !origins.length || origins.some((origin) => !ORIGINS.has(origin))
    || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw codedError('INVALID_BOOTSTRAP');
  }
  const isLocal = localPort !== undefined || localSecret !== undefined;
  const isNative = nativeSocksPort !== undefined;
  if (standaloneMtproxy !== undefined && (!isNative || standaloneSocksPort !== undefined
    || !isLocalProxyConfig(standaloneMtproxy))) throw codedError('INVALID_BOOTSTRAP');
  if (standaloneSocksPort !== undefined && (!isNative || !Number.isInteger(standaloneSocksPort)
    || standaloneSocksPort < 1024 || standaloneSocksPort > 65535 || standaloneSocksPort === nativeSocksPort)) {
    throw codedError('INVALID_BOOTSTRAP');
  }
  if (isNative && (!Number.isInteger(nativeSocksPort) || nativeSocksPort < 1 || nativeSocksPort > 65535
    || isLocal || socksPort !== undefined || mtproxy !== undefined)) throw codedError('INVALID_BOOTSTRAP');
  if (isLocal && (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535
    || typeof localSecret !== 'string' || !/^[a-f0-9]{32}$/i.test(localSecret)
    || socksPort !== undefined || mtproxy !== undefined)) throw codedError('INVALID_BOOTSTRAP');
  if (!isLocal && !isNative && (!Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65535)) {
    throw codedError('TUNNEL_SOCKS_MISSING');
  }
  if (!isLocal && !isNative && (typeof mtproxy !== 'string' || !mtproxy)) throw codedError('MTPROXY_NOT_CONFIGURED');
  const upstream = isNative ? undefined
    : isLocal ? { host: '127.0.0.1', port: localPort, secret: Buffer.from(localSecret, 'hex'), mode: 'plain' }
    : parseMtproxyLink(mtproxy);
  if (upstream?.mode === 'faketls') {
    upstream.secret.fill(0);
    throw codedError('MTPROXY_FAKETLS_UNSUPPORTED');
  }
  const allowedOrigins = new Set(origins);
  const tokenBytes = Buffer.from(token, 'ascii');
  const target = {
    socksPort: nativeSocksPort ?? socksPort,
    standaloneSocksPort,
    standaloneMtproxy: standaloneMtproxy && {
      port: standaloneMtproxy.port, secret: Buffer.from(standaloneMtproxy.secret, 'hex'),
    },
    host: upstream?.host,
    port: upstream?.port,
    secret: upstream?.secret,
    firstResponseTimeoutMs: isLocal ? LOCAL_FIRST_RESPONSE_TIMEOUT_MS : FIRST_RESPONSE_TIMEOUT_MS,
  };
  const hasStandalone = standaloneSocksPort !== undefined || standaloneMtproxy !== undefined;

  const server = http.createServer((_request, response) => {
    response.writeHead(404, { Connection: 'close', 'Content-Length': '0' });
    response.end();
  });
  server.maxHeadersCount = 16;
  server.maxConnections = MAX_CONNECTIONS * 2;
  server.headersTimeout = STARTUP_TIMEOUT_MS;
  server.requestTimeout = STARTUP_TIMEOUT_MS;
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });
  const connections = new Set();
  const httpSockets = new Set();
  let isClosing = false;
  server.on('connection', (socket) => {
    httpSockets.add(socket);
    socket.setTimeout(STARTUP_TIMEOUT_MS, () => socket.destroy());
    socket.on('close', () => httpSockets.delete(socket));
  });
  let pendingUpgrades = 0;
  server.on('upgrade', (request, socket, head) => {
    // RST от клиента на сыром сокете не должен ронять процесс: до передачи в ws обработчика 'error' нет
    const onRawError = () => socket.destroy();
    socket.on('error', onRawError);
    const route = parseRoute(request, tokenBytes, allowedOrigins, isNative, hasStandalone, standaloneMtproxy !== undefined);
    if (isClosing || !route || connections.size + pendingUpgrades >= MAX_CONNECTIONS) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      // слушатель живёт до закрытия: RST после end() тоже приходит как 'error'
      socket.once('close', () => socket.removeListener('error', onRawError));
      return;
    }
    pendingUpgrades++;
    openProxy(target, route).then((proxy) => {
      if (isClosing || socket.destroyed) {
        proxy.tcp.destroy();
        proxy.secret?.fill(0);
        return;
      }
      socket.setTimeout(0);
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        // дальше ошибки сокета обрабатывает ws
        socket.removeListener('error', onRawError);
        const connection = createConnection(webSocket, route, proxy, () => connections.delete(connection));
        connections.add(connection);
      });
    }, () => {
      if (socket.destroyed) return;
      socket.once('close', () => socket.removeListener('error', onRawError));
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }).finally(() => { pendingUpgrades--; });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('error', () => close());
  const heartbeat = setInterval(() => {
    for (const connection of connections) connection.ping();
  }, HEARTBEAT_INTERVAL_MS);
  const address = server.address();
  const standalone = hasStandalone ? '&standalone=1' : '';
  return { url: `ws://127.0.0.1:${address.port}/apiws?token=${token}${standalone}`, close };

  function close() {
    if (isClosing) return;
    isClosing = true;
    clearInterval(heartbeat);
    for (const connection of connections) connection.close();
    for (const socket of httpSockets) socket.destroy();
    webSockets.close();
    server.close();
    tokenBytes.fill(0);
    target.secret?.fill(0);
    target.standaloneMtproxy?.secret.fill(0);
  }
}

function isPublicIpv4(host) {
  if (net.isIP(host) !== 4) return false;
  const [a, b, c] = host.split('.').map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127
    && !(a === 100 && b >= 64 && b < 128)
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b < 32)
    && !(a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}

function parseRoute(request, tokenBytes, allowedOrigins, isNative, hasStandalone, standaloneIsMtproxy) {
  if (request.method !== 'GET' || !allowedOrigins.has(request.headers.origin)
    || request.headers['sec-websocket-protocol'] !== 'binary' || typeof request.url !== 'string'
    || request.url.length > MAX_SETTINGS_BYTES) return undefined;
  let url;
  try {
    url = new URL(request.url, 'http://127.0.0.1');
  } catch {
    return undefined;
  }
  if (url.pathname !== '/apiws') return undefined;
  const allowedKeys = new Set(['token', 'dc', 'media', 'premium', 'test', 'cdn', 'standalone']);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) return undefined;
  }
  const candidateToken = url.searchParams.get('token') || '';
  if (!/^[a-f0-9]{64}$/i.test(candidateToken)) return undefined;
  const candidate = Buffer.from(candidateToken, 'ascii');
  if (candidate.length !== tokenBytes.length || !timingSafeEqual(candidate, tokenBytes)) return undefined;
  const dc = url.searchParams.get('dc');
  const standalone = url.searchParams.has('standalone');
  if (standalone && (!hasStandalone || url.searchParams.get('standalone') !== '1')) return undefined;
  const cdn = url.searchParams.get('cdn');
  if (cdn !== null) {
    // CDN-адрес получен из help.getConfig в авторизованном клиенте. Разрешён только внешний IPv4 на 443.
    if (!isNative || (standalone && standaloneIsMtproxy) || !/^[1-9][0-9]{0,2}$/.test(dc || '') || !isPublicIpv4(cdn)
      || url.searchParams.size !== (standalone ? 4 : 3)) return undefined;
    return { dc: Number(dc), cdn, standalone };
  }
  if (!/^[1-5]$/.test(dc || '')) return undefined;
  for (const flag of ['media', 'premium', 'test']) {
    const value = url.searchParams.get(flag);
    if (url.searchParams.has(flag) && value !== '0' && value !== '1') return undefined;
  }
  if (url.searchParams.get('test') === '1') return undefined;
  // MTProxy selects the base DC for premium traffic and the negative DC for media
  return { dc: Number(dc) * (url.searchParams.get('media') === '1' ? -1 : 1), standalone };
}

function createConnection(webSocket, route, proxy, onClosed) {
  const { tcp, secret, firstResponseTimeoutMs } = proxy;
  let browserDecrypt;
  let browserEncrypt;
  let proxyDecrypt;
  let proxyEncrypt;
  let header = Buffer.alloc(0);
  let isConnected = false;
  let isClosed = false;
  let hasPong = true;
  let hasStarted = false;
  let pressureDeadline;
  let browserPressureDeadline;
  let firstResponseDeadline;
  const handshakeDeadline = setTimeout(close, HANDSHAKE_TIMEOUT_MS);
  webSocket.on('error', close);
  webSocket.on('close', close);
  webSocket.on('pong', () => { hasPong = true; });
  webSocket.on('message', (data, isBinary) => {
    if (isClosed) return;
    if (!isBinary || !Buffer.isBuffer(data)) return close();
    let chunk = data;
    if (!hasStarted) {
      const remaining = HEADER_BYTES - header.length;
      header = Buffer.concat([header, chunk.subarray(0, remaining)]);
      chunk = chunk.subarray(remaining);
      if (header.length === HEADER_BYTES) {
        hasStarted = true;
        try {
          const reversed = Buffer.from(header.subarray(8, 56)).reverse();
          browserDecrypt = createDecipheriv('aes-256-ctr', header.subarray(8, 40), header.subarray(40, 56));
          browserEncrypt = createCipheriv('aes-256-ctr', reversed.subarray(0, 32), reversed.subarray(32, 48));
          const decodedHeader = browserDecrypt.update(header);
          if (decodedHeader.readUInt32LE(56) !== PROTO_TAG) return close();
          startProxy();
        } catch {
          return close();
        }
      }
    }
    if (!chunk.length || !isConnected) return;
    sendToProxy(chunk);
  });
  // Ошибки и обрыв TCP до заголовка закрывают браузерный сокет так же, как после него
  tcp.on('error', close);
  tcp.on('end', close);
  tcp.on('close', close);

  return { close, ping };

  function startProxy() {
    let outgoingHeader = header;
    if (secret) {
      const proxyHeader = createProxyHeader(route.dc, secret);
      secret.fill(0);
      proxyEncrypt = proxyHeader.encrypt;
      proxyDecrypt = proxyHeader.decrypt;
      outgoingHeader = proxyHeader.bytes;
    }
    attachProxySocket();
    tcp.write(outgoingHeader);
    isConnected = true;
    clearTimeout(handshakeDeadline);
    firstResponseDeadline = setTimeout(close, firstResponseTimeoutMs);
  }

  function attachProxySocket() {
    tcp.on('drain', () => {
      clearTimeout(pressureDeadline);
      pressureDeadline = undefined;
      if (!isClosed) webSocket.resume();
    });
    tcp.on('data', (chunk) => {
      if (isClosed || webSocket.readyState !== WebSocket.OPEN) return close();
      clearTimeout(firstResponseDeadline);
      const encrypted = proxyDecrypt ? browserEncrypt.update(proxyDecrypt.update(chunk)) : chunk;
      webSocket.send(encrypted, { binary: true, compress: false }, (error) => {
        if (error) return close();
        if (!isClosed && webSocket.bufferedAmount < LOW_WATER_BYTES) {
          clearTimeout(browserPressureDeadline);
          browserPressureDeadline = undefined;
          tcp.resume();
        }
      });
      if (webSocket.bufferedAmount > MAX_BUFFER_BYTES) return close();
      if (webSocket.bufferedAmount > HIGH_WATER_BYTES) {
        tcp.pause();
        if (!browserPressureDeadline) browserPressureDeadline = setTimeout(close, BACKPRESSURE_TIMEOUT_MS);
      }
    });
    // После SOCKS-хэндшейка сокет стоит на паузе (см. socksConnect): поток включаем, когда слушатель уже есть
    tcp.resume();
  }

  function sendToProxy(chunk) {
    if (isClosed) return;
    const encrypted = proxyEncrypt ? proxyEncrypt.update(browserDecrypt.update(chunk)) : chunk;
    if (!tcp.write(encrypted)) {
      webSocket.pause();
      if (!pressureDeadline) pressureDeadline = setTimeout(close, BACKPRESSURE_TIMEOUT_MS);
    }
    if (tcp.writableLength > MAX_BUFFER_BYTES) close();
  }

  function ping() {
    if (!hasPong || webSocket.readyState !== WebSocket.OPEN) return close();
    hasPong = false;
    webSocket.ping(undefined, undefined, (error) => { if (error) close(); });
  }

  function close() {
    if (isClosed) return;
    isClosed = true;
    clearTimeout(handshakeDeadline);
    clearTimeout(pressureDeadline);
    clearTimeout(browserPressureDeadline);
    clearTimeout(firstResponseDeadline);
    header.fill(0);
    secret?.fill(0);
    tcp.destroy();
    webSocket.terminate();
    onClosed();
  }
}

async function openProxy({
  socksPort, standaloneSocksPort, standaloneMtproxy, host, port, secret, firstResponseTimeoutMs,
}, { dc, cdn, standalone }) {
  if (standalone && standaloneMtproxy) {
    const tcp = await connectLocalProxy(standaloneMtproxy.port);
    tcp.setNoDelay(true);
    tcp.setKeepAlive(true, HEARTBEAT_INTERVAL_MS);
    return { tcp, secret: Buffer.from(standaloneMtproxy.secret), firstResponseTimeoutMs };
  }
  const egressPort = standalone ? standaloneSocksPort : socksPort;
  const tcp = egressPort ? await socksConnect({
    socksPort: egressPort, host: host ?? cdn ?? TELEGRAM_DC_ADDRESSES[Math.abs(dc) - 1],
    port: port ?? 443, timeoutMs: CONNECT_TIMEOUT_MS,
  })
    : await connectLocalProxy(port);
  tcp.setNoDelay(true);
  tcp.setKeepAlive(true, HEARTBEAT_INTERVAL_MS);
  return { tcp, secret: secret && Buffer.from(secret), firstResponseTimeoutMs };
}

function connectLocalProxy(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let hasSettled = false;
    const deadline = setTimeout(() => finish(codedError('TELEGRAM_LOCAL_PROXY_TIMEOUT')), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish());
    socket.once('error', () => finish(codedError('TELEGRAM_LOCAL_PROXY_UNAVAILABLE')));
    socket.once('close', () => finish(codedError('TELEGRAM_LOCAL_PROXY_UNAVAILABLE')));
    function finish(error) {
      if (hasSettled) return;
      hasSettled = true;
      clearTimeout(deadline);
      socket.removeAllListeners('connect');
      socket.removeAllListeners('close');
      socket.removeAllListeners('error');
      socket.on('error', () => {});
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        socket.pause();
        resolve(socket);
      }
    }
  });
}

/**
 * SOCKS5 CONNECT без авторизации к 127.0.0.1:socksPort. Имя сервера уходит прокси строкой (socks5h): DNS-запрос
 * делает туннель, а не система. После ответа сокет остаётся на паузе; вызывающий включает поток сам.
 */
function socksConnect({
  socksPort, host, port, timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: socksPort });
    let buffered = Buffer.alloc(0);
    let need = 0;
    let onBytes;
    let stage = 'connect';
    let isDone = false;
    const deadline = setTimeout(() => finish(codedError('MTPROXY_SOCKS_TIMEOUT')), timeoutMs);
    socket.setNoDelay(true);
    socket.once('connect', () => {
      stage = 'greeting';
      expectBytes(2, onGreeting);
      socket.write(Buffer.from([5, 1, 0]));
    });
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 512) finish(codedError('MTPROXY_SOCKS_FAILED'));
      else check();
    });
    socket.on('error', () => finish(codedError(stage === 'connect' ? 'TUNNEL_SOCKS_UNAVAILABLE' : 'MTPROXY_SOCKS_FAILED')));
    socket.on('close', () => finish(codedError('MTPROXY_SOCKS_FAILED')));

    function expectBytes(count, handler) {
      need = count;
      onBytes = handler;
      check();
    }
    function check() {
      while (!isDone && onBytes && buffered.length >= need) {
        const bytes = buffered.subarray(0, need);
        buffered = buffered.subarray(need);
        const handler = onBytes;
        onBytes = undefined;
        handler(bytes);
      }
    }
    function onGreeting(bytes) {
      if (bytes[0] !== 5 || bytes[1] !== 0) return finish(codedError('MTPROXY_SOCKS_FAILED'));
      const kind = net.isIP(host);
      const address = kind === 4 ? Buffer.from(host.split('.').map(Number))
        : kind === 6 ? ipv6Bytes(host) : Buffer.from(host, 'ascii');
      const head = kind === 4 ? [5, 1, 0, 1] : kind === 6 ? [5, 1, 0, 4] : [5, 1, 0, 3, address.length];
      stage = 'reply';
      expectBytes(4, onReplyHead);
      socket.write(Buffer.concat([Buffer.from(head), address, Buffer.from([port >> 8, port & 255])]));
      return undefined;
    }
    function onReplyHead(bytes) {
      if (bytes[0] !== 5 || bytes[1] !== 0 || bytes[2] !== 0) return finish(codedError('MTPROXY_SOCKS_REFUSED'));
      if (bytes[3] === 1) expectBytes(6, () => finish());
      else if (bytes[3] === 4) expectBytes(18, () => finish());
      else if (bytes[3] === 3) expectBytes(1, (length) => expectBytes(length[0] + 2, () => finish()));
      else finish(codedError('MTPROXY_SOCKS_FAILED'));
      return undefined;
    }
    function finish(error) {
      if (isDone) return;
      isDone = true;
      clearTimeout(deadline);
      socket.removeAllListeners('data');
      socket.removeAllListeners('close');
      socket.removeAllListeners('error');
      if (error) {
        socket.on('error', () => {});
        socket.destroy();
        reject(error);
        return;
      }
      // Ошибки до подключения потока к WebSocket не должны ронять процесс
      socket.on('error', () => {});
      socket.pause();
      if (buffered.length) socket.unshift(buffered);
      resolve(socket);
    }
  });
}

/** 16 байт адреса IPv6 из текстовой формы (с `::`, без зоны и встроенного IPv4). */
function ipv6Bytes(text) {
  const [head, tail] = text.split('::');
  const read = (part) => (part ? part.split(':') : []);
  const first = read(head);
  const last = tail === undefined ? [] : read(tail);
  const groups = tail === undefined ? first
    : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group || '0', 16), index * 2));
  return bytes;
}

function isLoopbackHost(host) {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower === '0.0.0.0' || lower === '::' || lower === '::1') {
    return true;
  }
  return net.isIP(host) === 4 && host.split('.')[0] === '127';
}

/**
 * Разбор ссылки MTProxy (`tg://proxy?...` или `https://t.me/proxy?...`): server, port, secret.
 * Secret: 32 hex, `dd` + 32 hex, `ee` + 32 hex + домен (hex) либо те же байты в base64url.
 * Возвращает ключ (16 байт), режим (`plain` | `dd` | `faketls`) и узел. Secret в тексты ошибок не попадает.
 */
export function parseMtproxyLink(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_MTPROXY_LINK_LENGTH || /[\s\p{Control}]/u.test(value)) {
    throw codedError('MTPROXY_INVALID_LINK');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw codedError('MTPROXY_INVALID_LINK');
  }
  const isTg = url.protocol === 'tg:' && url.hostname === 'proxy';
  const isWeb = url.protocol === 'https:' && ['t.me', 'telegram.me'].includes(url.hostname) && url.pathname === '/proxy';
  if (!isTg && !isWeb) throw codedError('MTPROXY_INVALID_LINK');
  const host = (url.searchParams.get('server') || '').replace(/^\[|\]$/g, '');
  const portText = url.searchParams.get('port') || '';
  const secretText = url.searchParams.get('secret') || '';
  if (!host || !(net.isIP(host) || /^[a-z0-9.-]{1,253}$/i.test(host)) || !/^\d{1,5}$/.test(portText)) {
    throw codedError('MTPROXY_INVALID_LINK');
  }
  const port = Number(portText);
  if (port < 1 || port > 65535) throw codedError('MTPROXY_INVALID_LINK');
  if (isLoopbackHost(host)) throw codedError('MTPROXY_LOOPBACK_UNSUPPORTED');
  let raw;
  if (/^(?:[0-9a-f]{2})+$/i.test(secretText)) raw = Buffer.from(secretText, 'hex');
  else if (/^[A-Za-z0-9_-]+={0,2}$/.test(secretText)) raw = Buffer.from(secretText, 'base64url');
  if (!raw) throw codedError('MTPROXY_INVALID_SECRET');
  if (raw.length === 16) return { host, port, secret: Buffer.from(raw), mode: 'plain' };
  if (raw.length === 17 && raw[0] === 0xdd) return { host, port, secret: Buffer.from(raw.subarray(1)), mode: 'dd' };
  if (raw.length > 17 && raw[0] === 0xee) {
    return { host, port, secret: Buffer.from(raw.subarray(1, 17)), mode: 'faketls' };
  }
  throw codedError('MTPROXY_INVALID_SECRET');
}

function createProxyHeader(dc, secret) {
  let bytes;
  do {
    bytes = randomBytes(HEADER_BYTES);
  } while (bytes[0] === 0xef || FORBIDDEN_PREFIXES.has(bytes.subarray(0, 4).toString('hex'))
    || bytes.subarray(4, 8).equals(Buffer.alloc(4)));
  bytes.writeUInt32LE(PROTO_TAG, 56);
  bytes.writeInt16LE(dc, 60);
  const reversed = Buffer.from(bytes.subarray(8, 56)).reverse();
  const sendKey = createHash('sha256').update(bytes.subarray(8, 40)).update(secret).digest();
  const receiveKey = createHash('sha256').update(reversed.subarray(0, 32)).update(secret).digest();
  const encrypt = createCipheriv('aes-256-ctr', sendKey, bytes.subarray(40, 56));
  const decrypt = createDecipheriv('aes-256-ctr', receiveKey, reversed.subarray(32, 48));
  encrypt.update(bytes).subarray(56, HEADER_BYTES).copy(bytes, 56);
  sendKey.fill(0);
  receiveKey.fill(0);
  return { bytes, encrypt, decrypt };
}

function isLocalProxyConfig(config) {
  return config && Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535
    && typeof config.secret === 'string' && /^[a-f0-9]{32}$/i.test(config.secret);
}

// Проверяем настоящий ответ Telegram, прежде чем сохранить локальный прокси.
export async function probeLocalMtproxy(config, { timeoutMs = 4500, datacenters = [2, 4] } = {}) {
  if (!isLocalProxyConfig(config)) return false;
  const secret = Buffer.from(config.secret, 'hex');
  const abort = new globalThis.AbortController();
  try {
    await Promise.any(datacenters.map((dc) => probeMtproxyDc(config.port, secret, dc, timeoutMs, abort.signal)));
    return true;
  } catch {
    return false;
  } finally {
    abort.abort();
    secret.fill(0);
  }
}

function probeMtproxyDc(port, secret, dc, timeoutMs, signal) {
  const nonce = randomBytes(16);
  const request = Buffer.alloc(41);
  request[0] = 10;
  request.writeBigUInt64LE((BigInt(Date.now()) << 32n) / 1000n & ~3n, 9);
  request.writeUInt32LE(20, 17);
  request.writeUInt32LE(0xbe7e8ef1, 21);
  nonce.copy(request, 25);
  const { bytes, encrypt, decrypt } = createProxyHeader(dc, secret);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.concat([bytes, encrypt.update(request)]));
    });
    const timer = setTimeout(onFailure, timeoutMs);
    let response = Buffer.alloc(0);
    signal.addEventListener('abort', onFailure, { once: true });
    socket.once('error', onFailure);
    socket.once('close', onFailure);
    socket.on('data', (chunk) => {
      if (response.length + chunk.length > 2048) return onFailure();
      response = Buffer.concat([response, decrypt.update(chunk)]);
      const offset = response[0] === 0x7f ? 4 : 1;
      if (response.length < offset) return;
      const size = 4 * (offset === 1 ? response[0] : response.readUIntLE(1, 3));
      if (size < 40 || size > 2044) return onFailure();
      if (response.length < offset + size) return;
      const envelope = response.subarray(offset, offset + size);
      if (envelope.readBigUInt64LE(0) !== 0n || envelope.readUInt32LE(20) !== 0x05162463
        || !envelope.subarray(24, 40).equals(nonce)) return onFailure();
      finish();
      resolve();
    });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onFailure);
      socket.removeAllListeners('close');
      socket.removeAllListeners('data');
      socket.destroy();
    }
    function onFailure() {
      finish();
      reject(codedError('TELEGRAM_LOCAL_PROXY_UNAVAILABLE'));
    }
  });
}

async function runLocalMtproxyProbe() {
  try {
    process.stdin.setEncoding('utf8');
    let line = '';
    for await (const chunk of process.stdin) {
      line += chunk;
      if (Buffer.byteLength(line) > 256) throw codedError('INVALID_BOOTSTRAP');
    }
    process.exitCode = await probeLocalMtproxy(JSON.parse(line)) ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}

export function runTelegramTransportChild() {
  if (process.argv[2] === '--probe-local-mtproxy') {
    void runLocalMtproxyProbe();
    return;
  }
  let input = '';
  let hasSettings = false;
  let isStopping = false;
  let transport;
  const deadline = setTimeout(stop, STARTUP_TIMEOUT_MS);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (hasSettings || isStopping) return;
    input += chunk;
    if (Buffer.byteLength(input) > MAX_SETTINGS_BYTES) return stop();
    const newline = input.indexOf('\n');
    if (newline < 0) return;
    hasSettings = true;
    let settings;
    try {
      settings = JSON.parse(input.slice(0, newline));
    } catch {
      return stop();
    }
    input = '';
    createTelegramTransport(settings).then((result) => {
      transport = result;
      if (isStopping) return transport.close();
      clearTimeout(deadline);
      process.stdout.write(`${JSON.stringify({ status: 'ready', url: transport.url })}\n`);
    }).catch(stop);
  });
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.on('error', stop);
  // Причина падения пишется в stderr одной JSON-строкой без url, токена и заголовков
  process.on('uncaughtException', (error) => fatal('uncaughtException', error));
  process.on('unhandledRejection', (error) => fatal('unhandledRejection', error));

  function fatal(kind, error) {
    try {
      process.stderr.write(`${JSON.stringify({
        event: kind,
        name: typeof error?.name === 'string' ? error.name : undefined,
        code: typeof error?.code === 'string' ? error.code : undefined,
        message: typeof error?.message === 'string' ? error.message.slice(0, 200) : undefined,
      })}\n`);
    } catch { /* stderr недоступен */ }
    process.exit(1);
  }

  function stop(reason) {
    if (isStopping) return;
    isStopping = true;
    try {
      process.stderr.write(`${JSON.stringify({ event: 'exit', reason: describeStopReason(reason) })}\n`);
    } catch { /* stderr недоступен */ }
    clearTimeout(deadline);
    transport?.close();
    if (!transport) process.stdout.write(`${JSON.stringify({ status: 'unavailable' })}\n`);
    process.stdin.destroy();
    process.exitCode = 0;
  }
}

function describeStopReason(reason) {
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return typeof reason.code === 'string' ? reason.code : reason.name;
  return 'stop';
}
