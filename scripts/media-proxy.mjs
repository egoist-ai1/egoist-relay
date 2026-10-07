import net from 'node:net';
import tls from 'node:tls';
import { lookup } from 'node:dns';

const HANDSHAKE_TIMEOUT_MS = 15000;
const MAX_HANDSHAKE_BYTES = 16384;

export function parseMediaProxy(selected) {
  if (selected === 'direct') return undefined;
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

export async function connectMediaProxy(hostname, proxy, signal, overrides = {}) {
  if (!/^[a-z0-9.-]{1,253}$/i.test(hostname) || net.isIP(hostname) || signal.aborted) {
    throw new Error(signal.aborted ? 'MEDIA_CANCELLED' : 'MEDIA_PROXY_DENIED');
  }
  let socket;
  let reader;
  const failureCode = proxy ? 'MEDIA_PROXY_FAILED' : 'MEDIA_CONNECTION_FAILED';
  try {
    socket = proxy?.protocol === 'https:'
      ? tls.connect({ host: proxy.hostname, port: proxy.port, servername: net.isIP(proxy.hostname) ? undefined : proxy.hostname, rejectUnauthorized: true, signal })
      : proxy ? net.connect({ host: proxy.hostname, port: proxy.port, signal })
        : (overrides.connect || net.connect)({ host: hostname, port: 443, lookup: createPublicLookup(overrides.lookup || lookup), autoSelectFamily: true, signal });
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy(new Error(failureCode)));
    await new Promise((resolve, reject) => {
      const readyEvent = proxy?.protocol === 'https:' ? 'secureConnect' : 'connect';
      function cleanup() { socket.off(readyEvent, onReady); socket.off('error', onFailure); socket.off('close', onFailure); }
      function onReady() { cleanup(); resolve(); }
      function onFailure(error) { cleanup(); reject(error?.message === 'MEDIA_ADDRESS_DENIED' ? error : new Error(failureCode)); }
      socket.once(readyEvent, onReady); socket.once('error', onFailure); socket.once('close', onFailure);
    });
    if (!proxy) { socket.setTimeout(0); return socket; }
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
    throw new Error(signal.aborted ? 'MEDIA_CANCELLED' : error.message === 'MEDIA_ADDRESS_DENIED' ? error.message : failureCode, { cause: error });
  }
}

function createPublicLookup(resolve) {
  return (hostname, options, callback) => resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) { callback(error); return; }
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32
      || addresses.some(record => net.isIP(record.address) !== record.family || !isPublicAddress(record.address))) {
      callback(new Error('MEDIA_ADDRESS_DENIED')); return;
    }
    const selected = options.family ? addresses.filter(record => record.family === options.family) : addresses;
    if (!selected.length) { callback(new Error('MEDIA_ADDRESS_DENIED')); return; }
    if (options.all) callback(undefined, selected);
    else callback(undefined, selected[0].address, selected[0].family);
  });
}

function isPublicAddress(value) {
  if (net.isIP(value) === 4) {
    const [first, second, third] = value.split('.').map(Number);
    return !(first === 0 || first === 10 || first === 127 || first >= 224
      || first === 100 && second >= 64 && second <= 127 || first === 169 && second === 254
      || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168
      || first === 192 && (second === 0 && (third === 0 || third === 2) || second === 88 && third === 99)
      || first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)
      || first === 203 && second === 0 && third === 113);
  }
  if (net.isIP(value) !== 6) return false;
  const [first, second = '0'] = value.split(':').map(part => part || '0');
  const prefix = Number.parseInt(first, 16);
  const subnet = Number.parseInt(second, 16);
  return prefix >= 0x2000 && prefix < 0x4000 && prefix !== 0x2002 && prefix !== 0x3fff
    && !(prefix === 0x2001 && (subnet < 0x200 || subnet === 0xdb8));
}
