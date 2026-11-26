import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

const HANDSHAKE_TIMEOUT_MS = 15000;
const MAX_HANDSHAKE_BYTES = 16384;

const LOCAL_OR_RESERVED_IP = new net.BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) LOCAL_OR_RESERVED_IP.addSubnet(subnet, prefix, 'ipv4');
for (const [subnet, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) LOCAL_OR_RESERVED_IP.addSubnet(subnet, prefix, 'ipv6');
const GLOBAL_IPV6 = new net.BlockList();
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');

function lookupPublicMediaHost(hostname, options, callback) {
  dns.lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
    if (error) { callback(error); return; }
    // Системная сеть может вернуть синтетический адрес 198.18/15. Подлинность имени проверяет TLS.
    // Фильтруем именно те адреса, которые подключает сокет, без повторного DNS-запроса
    const publicAddresses = addresses.filter(({ address, family }) => family === 4
      ? !LOCAL_OR_RESERVED_IP.check(address, 'ipv4')
      : GLOBAL_IPV6.check(address, 'ipv6') && !LOCAL_OR_RESERVED_IP.check(address, 'ipv6'));
    if (!publicAddresses.length) { callback(new Error('MEDIA_URL_DENIED')); return; }
    if (options.all) callback(null, publicAddresses);
    else callback(null, publicAddresses[0].address, publicAddresses[0].family);
  });
}

export async function connectMediaOrigin(hostname, signal) {
  if (!/^[a-z0-9.-]{1,253}$/i.test(hostname) || net.isIP(hostname)) throw new Error('MEDIA_URL_DENIED');
  if (signal.aborted) throw new Error('MEDIA_CANCELLED');
  const socket = net.connect({ host: hostname, port: 443, signal, lookup: lookupPublicMediaHost });
  try {
    await new Promise((resolve, reject) => {
      function cleanup() {
        socket.off('connect', onConnect);
        socket.off('error', onError);
        socket.off('timeout', onTimeout);
        socket.setTimeout(0);
      }
      function onConnect() { cleanup(); resolve(); }
      function onError(error) { cleanup(); reject(error); }
      function onTimeout() { onError(new Error('MEDIA_TIMEOUT')); }
      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.setTimeout(HANDSHAKE_TIMEOUT_MS, onTimeout);
    });
    return socket;
  } catch (error) {
    socket.destroy();
    if (signal.aborted) throw new Error('MEDIA_CANCELLED', { cause: error });
    if (error.message === 'MEDIA_URL_DENIED' || error.message === 'MEDIA_TIMEOUT') throw error;
    throw new Error('MEDIA_CONNECTION_FAILED', { cause: error });
  }
}

export function parseMediaProxy(selected) {
  // Прямого маршрута нет: пустой, отсутствующий и `direct` — отказ (fail-closed)
  if (typeof selected !== 'string' || !selected || selected.length > 4096 || /[\s\\\p{Control}]/u.test(selected)) {
    throw new Error('MEDIA_PROXY_DENIED');
  }
  let url;
  try { url = new URL(selected); } catch { throw new Error('MEDIA_PROXY_DENIED'); }
  if (!['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname
    || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash || url.port === '0') {
    throw new Error('MEDIA_PROXY_DENIED');
  }
  const port = Number(url.port || (url.protocol === 'http:' ? 80 : url.protocol === 'https:' ? 443 : 1080));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MEDIA_PROXY_DENIED');
  return { protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port };
}

export function createSocketReader(socket) {
  let buffered = Buffer.alloc(0);
  let pending;
  let failure;
  function settle() {
    if (!pending) return;
    if (failure) { const current = pending; pending = undefined; current.reject(failure); return; }
    const size = pending.count || (buffered.indexOf('\r\n\r\n') + 4);
    if (size < 4 && !pending.count || buffered.length < size) return;
    const current = pending; pending = undefined;
    const result = buffered.subarray(0, size); buffered = buffered.subarray(size);
    current.resolve(result);
  }
  function onFailure() { failure = new Error('MEDIA_PROXY_FAILED'); settle(); }
  function onData(chunk) {
    if (buffered.length + chunk.length > MAX_HANDSHAKE_BYTES) { onFailure(); socket.destroy(); return; }
    buffered = Buffer.concat([buffered, chunk]); settle();
  }
  socket.on('data', onData); socket.on('error', onFailure); socket.on('end', onFailure); socket.on('close', onFailure);
  return {
    read: count => new Promise((resolve, reject) => { pending = { count, resolve, reject }; settle(); }),
    release: () => {
      socket.pause(); socket.off('data', onData); socket.off('error', onFailure); socket.off('end', onFailure); socket.off('close', onFailure);
      if (buffered.length) socket.unshift(buffered);
    },
  };
}

export async function connectMediaProxy(hostname, proxy, signal) {
  if (!proxy) throw new Error('MEDIA_PROXY_DENIED');
  if (!/^[a-z0-9.-]{1,253}$/i.test(hostname) || net.isIP(hostname) || signal.aborted) {
    throw new Error(signal.aborted ? 'MEDIA_CANCELLED' : 'MEDIA_PROXY_DENIED');
  }
  let socket;
  let reader;
  const failureCode = 'MEDIA_PROXY_FAILED';
  try {
    socket = proxy.protocol === 'https:'
      ? tls.connect({ host: proxy.hostname, port: proxy.port, servername: net.isIP(proxy.hostname) ? undefined : proxy.hostname, rejectUnauthorized: true, signal })
      : net.connect({ host: proxy.hostname, port: proxy.port, signal });
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy(new Error(failureCode)));
    await new Promise((resolve, reject) => {
      const readyEvent = proxy.protocol === 'https:' ? 'secureConnect' : 'connect';
      function cleanup() { socket.off(readyEvent, onReady); socket.off('error', onFailure); socket.off('close', onFailure); }
      function onReady() { cleanup(); resolve(); }
      function onFailure() { cleanup(); reject(new Error(failureCode)); }
      socket.once(readyEvent, onReady); socket.once('error', onFailure); socket.once('close', onFailure);
    });
    reader = createSocketReader(socket);
    if (['http:', 'https:'].includes(proxy.protocol)) {
      socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nProxy-Connection: keep-alive\r\n\r\n`);
      const response = await reader.read();
      if (!/^HTTP\/1\.[01] 200(?: |\r\n)/.test(response.toString('latin1'))) throw new Error('MEDIA_PROXY_FAILED');
    } else {
      socket.write(Buffer.from([5, 1, 0]));
      const greeting = await reader.read(2);
      if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error('MEDIA_PROXY_FAILED');
      const address = Buffer.from(hostname);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, address.length]), address, Buffer.from([1, 187])]));
      const response = await reader.read(4);
      if (response[0] !== 5 || response[1] !== 0 || response[2] !== 0) throw new Error('MEDIA_PROXY_FAILED');
      const size = response[3] === 1 ? 4 : response[3] === 4 ? 16 : response[3] === 3 ? (await reader.read(1))[0] : 0;
      if (!size) throw new Error('MEDIA_PROXY_FAILED');
      await reader.read(size + 2);
    }
    reader.release(); reader = undefined;
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    reader?.release(); socket?.destroy();
    throw new Error(signal.aborted ? 'MEDIA_CANCELLED' : failureCode, { cause: error });
  }
}
