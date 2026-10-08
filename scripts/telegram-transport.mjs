import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { WebSocket, WebSocketServer } from 'ws';

const STARTUP_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 1000;
const CONNECT_RETRY_MS = 150;
// Две быстрые попытки укладываются в клиентский дедлайн локального маршрута (2,5 с), дальше клиент идёт напрямую
const MAX_CONNECT_ATTEMPTS = 2;
const MAX_HANDOFF_BYTES = 4096;
const HANDSHAKE_TIMEOUT_MS = 8000;
const FIRST_RESPONSE_TIMEOUT_MS = 12000;
const HEARTBEAT_INTERVAL_MS = 20000;
const BACKPRESSURE_TIMEOUT_MS = 20000;
const MAX_CONFIG_BYTES = 65536;
const MAX_SETTINGS_BYTES = 4096;
const MAX_CONNECTIONS = 128;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;
const HEADER_BYTES = 64;
const PROTO_TAG = 0xefefefef;
const ORIGINS = new Set([
  'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost', 'http://localhost:1234',
]);
const FORBIDDEN_PREFIXES = new Set(['48454144', '504f5354', '47455420', '4f505449', '16030102', 'dddddddd', 'eeeeeeee']);

export async function createTelegramTransport({ token, origins, port = 0 }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)
    || !Array.isArray(origins) || !origins.length || origins.some((origin) => !ORIGINS.has(origin))
    || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('INVALID_BOOTSTRAP');
  }
  const allowedOrigins = new Set(origins);
  const tokenBytes = Buffer.from(token, 'ascii');
  let reason;
  try {
    const initialConfig = await readLagomConfig();
    initialConfig.secret.fill(0);
    await checkListener(initialConfig);
  } catch (error) {
    reason = classifyLagomFailure(error);
  }

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
    const route = parseRoute(request, tokenBytes, allowedOrigins);
    if (isClosing || !route || connections.size + pendingUpgrades >= MAX_CONNECTIONS) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // WebSocket открывается только после того, как достигнут Lagom: открытый сокет означает рабочий маршрут,
    // а недоступный Lagom даёт мгновенный отказ, после которого клиент идёт прямым путём
    pendingUpgrades++;
    openProxy().then((proxy) => {
      if (isClosing || socket.destroyed) {
        proxy.tcp.destroy();
        proxy.secret.fill(0);
        return;
      }
      socket.setTimeout(0);
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        const connection = createConnection(webSocket, route, proxy, () => connections.delete(connection));
        connections.add(connection);
      });
    }, () => {
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
  return { url: `ws://127.0.0.1:${address.port}/apiws?token=${token}`, close, reason };

  function close() {
    if (isClosing) return;
    isClosing = true;
    clearInterval(heartbeat);
    for (const connection of connections) connection.close();
    for (const socket of httpSockets) socket.destroy();
    webSockets.close();
    server.close();
    tokenBytes.fill(0);
  }
}

function parseRoute(request, tokenBytes, allowedOrigins) {
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
  const allowedKeys = new Set(['token', 'dc', 'media', 'premium', 'test']);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) return undefined;
  }
  const candidateToken = url.searchParams.get('token') || '';
  if (!/^[a-f0-9]{64}$/i.test(candidateToken)) return undefined;
  const candidate = Buffer.from(candidateToken, 'ascii');
  if (candidate.length !== tokenBytes.length || !timingSafeEqual(candidate, tokenBytes)) return undefined;
  const dc = url.searchParams.get('dc');
  if (!/^[1-5]$/.test(dc || '')) return undefined;
  for (const flag of ['media', 'premium', 'test']) {
    const value = url.searchParams.get(flag);
    if (url.searchParams.has(flag) && value !== '0' && value !== '1') return undefined;
  }
  if (url.searchParams.get('test') === '1') return undefined;
  // MTProxy selects the base DC for premium traffic and the negative DC for media
  return { dc: Number(dc) * (url.searchParams.get('media') === '1' ? -1 : 1) };
}

function createConnection(webSocket, route, proxy, onClosed) {
  const { tcp, secret } = proxy;
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
    const proxyHeader = createProxyHeader(route.dc, secret);
    secret.fill(0);
    proxyEncrypt = proxyHeader.encrypt;
    proxyDecrypt = proxyHeader.decrypt;
    attachProxySocket();
    tcp.write(proxyHeader.bytes);
    isConnected = true;
    clearTimeout(handshakeDeadline);
    firstResponseDeadline = setTimeout(close, FIRST_RESPONSE_TIMEOUT_MS);
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
      const encrypted = browserEncrypt.update(proxyDecrypt.update(chunk));
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
  }

  function sendToProxy(chunk) {
    if (isClosed) return;
    const encrypted = proxyEncrypt.update(browserDecrypt.update(chunk));
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
    secret.fill(0);
    tcp.destroy();
    webSocket.terminate();
    onClosed();
  }
}

/** Подключается к Lagom (конфиг читается заново, чтобы подхватить смену порта/secret) с короткими повторами. */
async function openProxy() {
  for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
    let config;
    try {
      config = await readLagomConfig();
      const tcp = await connectProxySocket(config);
      const secret = config.secret;
      config = undefined;
      return { tcp, secret };
    } catch (error) {
      if (!isRetryableLagomFailure(error) || attempt + 1 >= MAX_CONNECT_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    } finally {
      config?.secret.fill(0);
    }
  }
  throw new Error('LAGOM_LISTENER_UNAVAILABLE');
}

function connectProxySocket({ host, port }) {
  return new Promise((resolve, reject) => {
    const candidate = net.createConnection({ host, port });
    candidate.setNoDelay(true);
    candidate.setKeepAlive(true, HEARTBEAT_INTERVAL_MS);
    const deadline = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    candidate.once('connect', onConnected);
    candidate.once('error', onFailed);
    candidate.once('close', onFailed);
    function onConnected() { finish(true); }
    function onFailed() { finish(false); }
    function finish(isAvailable) {
      clearTimeout(deadline);
      candidate.removeListener('connect', onConnected);
      candidate.removeListener('error', onFailed);
      candidate.removeListener('close', onFailed);
      if (isAvailable) {
        candidate.on('error', () => {});
        resolve(candidate);
      } else {
        candidate.destroy();
        reject(new Error('LAGOM_LISTENER_UNAVAILABLE'));
      }
    }
  });
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

async function readLagomConfig() {
  const programData = process.env.ProgramData;
  let primaryFailure;
  if (programData && path.isAbsolute(programData)) {
    const configPath = path.join(programData, 'EgoistShield', 'Runtime', 'TelegramProxy', 'config.json');
    try {
      return await readLagomFile(configPath, false);
    } catch (error) {
      if (!isUnreadableLagomFile(error)) throw new Error('LAGOM_INVALID_CONFIG', { cause: error });
      primaryFailure = error;
    }
  }
  const localData = process.env.LOCALAPPDATA;
  if (!localData || !path.isAbsolute(localData)) throw new Error('LAGOM_CONFIG_UNAVAILABLE');
  const handoffPath = path.join(localData, 'EgoistRelay', 'interop', 'lagom-telegram.json');
  try {
    return await readLagomFile(handoffPath, true);
  } catch (error) {
    if (!isUnreadableLagomFile(error)) throw new Error('LAGOM_INVALID_CONFIG', { cause: error });
    const isDenied = [error?.code, primaryFailure?.code].some((code) => code === 'EACCES' || code === 'EPERM');
    throw new Error(isDenied ? 'LAGOM_CONFIG_ACCESS_DENIED' : 'LAGOM_CONFIG_UNAVAILABLE', { cause: error });
  }
}

async function readLagomFile(configPath, isHandoff) {
  let file;
  let bytes;
  try {
    const resolvedPath = await realpath(configPath);
    if (resolvedPath.toLowerCase() !== path.resolve(configPath).toLowerCase()) throw new Error('INVALID_CONFIG_PATH');
    for (let current = configPath; current;) {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('INVALID_CONFIG_PATH');
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    file = await open(configPath, fsConstants.O_RDONLY);
    const stat = await file.stat();
    const maximum = isHandoff ? MAX_HANDOFF_BYTES : MAX_CONFIG_BYTES;
    if (!stat.isFile() || stat.size > maximum || stat.nlink !== 1) throw new Error('INVALID_CONFIG_SIZE');
    bytes = Buffer.alloc(maximum + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maximum) throw new Error('INVALID_CONFIG_SIZE');
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) throw new Error('INVALID_CONFIG_CHANGED');
    const config = JSON.parse(bytes.toString('utf8', 0, bytesRead));
    if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('INVALID_CONFIG');
    if (isHandoff && (config.schemaVersion !== 1 || Object.keys(config).sort().join(',') !== 'host,port,schemaVersion,secret')) {
      throw new Error('INVALID_CONFIG');
    }
    const hosts = isHandoff ? ['127.0.0.1'] : ['127.0.0.1', '::1', 'localhost'];
    if (!hosts.includes(config.host) || !Number.isInteger(config.port)
      || config.port < (isHandoff ? 1 : 1024) || config.port > 65535 || typeof config.secret !== 'string'
      || !/^[a-f0-9]{32}$/i.test(config.secret)) throw new Error('INVALID_CONFIG');
    const secret = Buffer.from(config.secret, 'hex');
    config.secret = '';
    return { host: config.host === 'localhost' ? '127.0.0.1' : config.host, port: config.port, secret };
  } finally {
    bytes?.fill(0);
    await file?.close();
  }
}

function isUnreadableLagomFile(error) {
  return ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error?.code);
}

function classifyLagomFailure(error) {
  return ['LAGOM_CONFIG_ACCESS_DENIED', 'LAGOM_CONFIG_UNAVAILABLE', 'LAGOM_LISTENER_UNAVAILABLE', 'LAGOM_INVALID_CONFIG']
    .includes(error?.message) ? error.message : 'LAGOM_INVALID_CONFIG';
}

function isRetryableLagomFailure(error) {
  return ['LAGOM_CONFIG_ACCESS_DENIED', 'LAGOM_CONFIG_UNAVAILABLE', 'LAGOM_LISTENER_UNAVAILABLE'].includes(error?.message);
}

async function checkListener({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const deadline = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    let hasFinished = false;
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    function finish(isAvailable) {
      if (hasFinished) return;
      hasFinished = true;
      clearTimeout(deadline);
      socket.destroy();
      if (isAvailable) resolve();
      else reject(new Error('LAGOM_LISTENER_UNAVAILABLE'));
    }
  });
}

export function runTelegramTransportChild() {
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
      process.stdout.write(`${JSON.stringify({ status: 'ready', url: transport.url, reason: transport.reason })}\n`);
    }).catch(stop);
  });
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.on('error', stop);

  function stop() {
    if (isStopping) return;
    isStopping = true;
    clearTimeout(deadline);
    transport?.close();
    if (!transport) process.stdout.write(`${JSON.stringify({ status: 'unavailable' })}\n`);
    process.stdin.destroy();
    process.exitCode = 0;
  }
}
