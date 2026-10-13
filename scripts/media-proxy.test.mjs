import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { connectMediaProxy, createSocketReader, parseMediaProxy } from './media-proxy.mjs';
import { createEngineArgs, createSocksGate, resolveMedia } from './inline-media-resolver.mjs';
import { fetchMedia } from './social-media-fetch.mjs';
import { startFixtureProxy } from './media-test-proxy.mjs';

const previousProxy = process.env.EGOIST_RELAY_MEDIA_PROXY;
let fixtureProxy;
test.before(async () => { fixtureProxy = await startFixtureProxy(); process.env.EGOIST_RELAY_MEDIA_PROXY = fixtureProxy.url; });
test.after(async () => {
  if (previousProxy === undefined) delete process.env.EGOIST_RELAY_MEDIA_PROXY; else process.env.EGOIST_RELAY_MEDIA_PROXY = previousProxy;
  await fixtureProxy?.close();
});

function useProxy(context, selected) {
  const previous = process.env.EGOIST_RELAY_MEDIA_PROXY;
  process.env.EGOIST_RELAY_MEDIA_PROXY = selected;
  context.after(() => { process.env.EGOIST_RELAY_MEDIA_PROXY = previous; });
}

async function createTestServer(context, handleSocket) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    void Promise.resolve(handleSocket(socket)).catch(() => socket.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

async function acceptSocksRequest(socket) {
  const reader = createSocketReader(socket);
  assert.deepEqual(await reader.read(3), Buffer.from([5, 1, 0]));
  socket.write(Buffer.from([5]));
  setTimeout(() => socket.write(Buffer.from([0])), 2);
  const request = await reader.read(5);
  assert.deepEqual(request.subarray(0, 4), Buffer.from([5, 1, 0, 3]));
  const target = await reader.read(request[4] + 2);
  assert.equal(target.readUInt16BE(target.length - 2), 443);
  reader.release();
  return target.subarray(0, -2).toString('utf8');
}

test('SOCKS forwards the hostname and preserves early tunnel bytes', { timeout: 5000 }, async context => {
  let target;
  const port = await createTestServer(context, async socket => {
    target = await acceptSocksRequest(socket);
    socket.write(Buffer.concat([Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from('ready')]));
  });
  const socket = await connectMediaProxy('pbs.twimg.com', parseMediaProxy(`socks5h://127.0.0.1:${port}`), new globalThis.AbortController().signal);
  context.after(() => socket.destroy());
  const reader = createSocketReader(socket); socket.resume();
  assert.equal((await reader.read(5)).toString(), 'ready');
  assert.equal(target, 'pbs.twimg.com');
  reader.release();
});

test('HTTP CONNECT uses the selected proxy and rejects denial', { timeout: 5000 }, async context => {
  let request;
  let shouldDeny = false;
  const port = await createTestServer(context, async socket => {
    const reader = createSocketReader(socket);
    request = (await reader.read()).toString(); reader.release();
    socket.write(shouldDeny ? 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n' : 'HTTP/1.1 200 Connection established\r\n\r\n');
  });
  const proxy = parseMediaProxy(`http://127.0.0.1:${port}`);
  const socket = await connectMediaProxy('video.twimg.com', proxy, new globalThis.AbortController().signal);
  socket.destroy();
  assert.match(request, /^CONNECT video\.twimg\.com:443 HTTP\/1\.1/);
  shouldDeny = true;
  await assert.rejects(connectMediaProxy('video.twimg.com', proxy, new globalThis.AbortController().signal), /MEDIA_PROXY_FAILED/);
});

test('TLS proxy validation fails closed on a non-TLS endpoint', { timeout: 5000 }, async context => {
  const port = await createTestServer(context, socket => { socket.once('data', () => socket.end('HTTP/1.1 200 Invalid TLS\r\n\r\n')); });
  await assert.rejects(connectMediaProxy('pbs.twimg.com', parseMediaProxy(`https://127.0.0.1:${port}`), new globalThis.AbortController().signal), /MEDIA_PROXY_FAILED/);
});

test('Canceling a pending proxy handshake closes its socket', { timeout: 5000 }, async context => {
  let observeConnection;
  const connected = new Promise(resolve => { observeConnection = resolve; });
  const port = await createTestServer(context, socket => { observeConnection(socket); });
  const controller = new globalThis.AbortController();
  const connection = connectMediaProxy('pbs.twimg.com', parseMediaProxy(`socks5h://127.0.0.1:${port}`), controller.signal);
  const remote = await connected;
  const closed = new Promise(resolve => remote.once('close', resolve));
  controller.abort();
  await assert.rejects(connection, /MEDIA_CANCELLED/);
  await closed;
});

test('Actual CDN fetch reaches TLS through the SOCKS hostname route', { timeout: 5000 }, async context => {
  let target;
  const port = await createTestServer(context, async socket => {
    target = await acceptSocksRequest(socket);
    socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    socket.resume();
    socket.once('data', () => socket.end('not TLS'));
  });
  useProxy(context, `socks5h://127.0.0.1:${port}`);
  await assert.rejects(fetchMedia({ url: 'https://pbs.twimg.com/media/test.jpg', service: 'x', type: 'photo', index: 0, proxyPort: port }), /MEDIA_TLS_FAILED/);
  assert.equal(target, 'pbs.twimg.com');
});

test('Resolver gate denies unrelated hosts before opening an upstream socket', { timeout: 5000 }, async context => {
  let upstreamConnections = 0;
  const port = await createTestServer(context, () => { upstreamConnections++; });
  const gate = await createSocksGate(parseMediaProxy(`socks5h://127.0.0.1:${port}`), 'x', new globalThis.AbortController().signal);
  context.after(() => gate.close());
  await assert.rejects(connectMediaProxy('example.com', parseMediaProxy(`socks5h://127.0.0.1:${gate.port}`), new globalThis.AbortController().signal), /MEDIA_PROXY_FAILED/);
  assert.equal(upstreamConnections, 0);
});

test('Resolver gate forwards allowed hosts through HTTP CONNECT', { timeout: 5000 }, async context => {
  let request;
  const port = await createTestServer(context, async socket => {
    const reader = createSocketReader(socket); request = (await reader.read()).toString(); reader.release();
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
  });
  const gate = await createSocksGate(parseMediaProxy(`http://127.0.0.1:${port}`), 'instagram', new globalThis.AbortController().signal);
  context.after(() => gate.close());
  const socket = await connectMediaProxy('www.instagram.com', parseMediaProxy(`socks5h://127.0.0.1:${gate.port}`), new globalThis.AbortController().signal);
  socket.destroy();
  assert.match(request, /^CONNECT www\.instagram\.com:443 HTTP\/1\.1/);
});

test('Proxy configuration rejects credentials, paths and malformed values', () => {
  for (const value of [undefined, 'http://user:secret@127.0.0.1:8080', 'http://127.0.0.1:8080/path', 'socks5://127.0.0.1:0', 'direct://example.com', 'http://127.0.0.1:\n8080', '', 'DIRECT', ' direct', 'direct']) {
    assert.throws(() => parseMediaProxy(value), /MEDIA_PROXY_DENIED/);
  }
});

// Весь трафик идёт через тестовый CONNECT-прокси (см. test.before), который пересылает на TLS-стенд `port`
function createFixtureTransport(port, alpn = 'http/1.1') {
  fixtureProxy.setTarget(port);
  return {
    connectTls: options => {
      assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, 'pbs.twimg.com');
      return tls.connect({ ...options, ca: TLS_TEST_CERT, ALPNProtocols: [alpn] });
    },
  };
}

async function createTlsFixture(context, handleRequest) {
  const sockets = new Set();
  const server = http2.createSecureServer({ key: TLS_TEST_KEY, cert: TLS_TEST_CERT, allowHTTP1: true });
  server.on('request', handleRequest);
  server.on('sessionError', () => {});
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

for (const alpn of ['http/1.1', 'h2']) {
  test(`Selected proxy completes a validated native HTTPS ${alpn} media GET`, { timeout: 5000 }, async context => {
    const photo = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    const requests = [];
    const port = await createTlsFixture(context, (request, response) => {
      requests.push({ url: request.url, servername: request.socket.servername, host: request.headers.host || request.headers[':authority'] });
      response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': photo.length }); response.end(photo);
    });
    const result = await fetchMedia({ url: 'https://pbs.twimg.com/media/test.jpg?format=jpg', service: 'x', type: 'photo', index: 0 }, createFixtureTransport(port, alpn));
    assert.deepEqual(result.body, photo);
    assert.equal(result.metadata.mimeType, 'image/jpeg');
    assert.deepEqual(requests, [{ url: '/media/test.jpg?format=jpg', servername: 'pbs.twimg.com', host: alpn === 'h2' ? 'pbs.twimg.com:443' : 'pbs.twimg.com' }]);
  });
}

for (const protocol of ['http', 'socks5h']) {
  test(`Selected ${protocol} proxy carries a complete native CDN HTTPS GET`, { timeout: 5000 }, async context => {
    const photo = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    const tlsPort = await createTlsFixture(context, (request, response) => { response.writeHead(200, { 'content-length': photo.length }); response.end(photo); });
    const targets = [];
    const proxyPort = await createTestServer(context, async socket => {
      if (protocol === 'http') {
        const reader = createSocketReader(socket); const request = (await reader.read()).toString(); reader.release();
        assert.match(request, /^CONNECT pbs\.twimg\.com:443 HTTP\/1\.1/); targets.push('pbs.twimg.com');
      } else targets.push(await acceptSocksRequest(socket));
      const upstream = net.connect({ host: '127.0.0.1', port: tlsPort });
      upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
      await new Promise((resolve, reject) => { upstream.once('connect', resolve); upstream.once('error', reject); });
      socket.write(protocol === 'http' ? 'HTTP/1.1 200 Connection established\r\n\r\n' : Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      socket.pipe(upstream); upstream.pipe(socket);
    });
    useProxy(context, `${protocol}://127.0.0.1:${proxyPort}`);
    const transport = createFixtureTransport(tlsPort, 'h2');
    transport.connect = () => { throw new Error('UNEXPECTED_DIRECT'); };
    transport.lookup = () => { throw new Error('UNEXPECTED_DNS'); };
    const result = await fetchMedia({ url: 'https://pbs.twimg.com/media/test.jpg', service: 'x', type: 'photo', index: 0 }, transport);
    assert.deepEqual(result.body, photo); assert.deepEqual(targets, ['pbs.twimg.com']);
  });
}

test('Proxied native HTTPS preserves certificate verification', { timeout: 5000 }, async context => {
  const port = await createTlsFixture(context, (request, response) => response.end());
  const transport = createFixtureTransport(port); delete transport.connectTls;
  await assert.rejects(fetchMedia({ url: 'https://pbs.twimg.com/media/test.jpg', service: 'x', type: 'photo', index: 0 }, transport), /MEDIA_TLS_FAILED/);
});

test('An explicit failed proxy never opens the direct connector or resolves the target locally', { timeout: 5000 }, async context => {
  const port = await createTestServer(context, async socket => {
    const reader = createSocketReader(socket); await reader.read(); reader.release();
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
  });
  useProxy(context, `http://127.0.0.1:${port}`);
  let directCalls = 0;
  await assert.rejects(fetchMedia({ url: 'https://pbs.twimg.com/media/test.jpg', service: 'x', type: 'photo', index: 0 }, {
    connect: () => { directCalls++; throw new Error('UNEXPECTED_DIRECT'); },
    lookup: () => { directCalls++; throw new Error('UNEXPECTED_DNS'); },
  }), /MEDIA_PROXY_FAILED/);
  assert.equal(directCalls, 0);
});

test('Missing and malformed routes fail before any media transport', async context => {
  let calls = 0;
  const selected = process.env.EGOIST_RELAY_MEDIA_PROXY;
  context.after(() => { process.env.EGOIST_RELAY_MEDIA_PROXY = selected; });
  for (const route of [undefined, '', 'http://bad/proxy', 'not-a-proxy']) {
    if (route === undefined) delete process.env.EGOIST_RELAY_MEDIA_PROXY; else process.env.EGOIST_RELAY_MEDIA_PROXY = route;
    await assert.rejects(fetchMedia({ url: 'https://pbs.twimg.com/media/test.jpg', service: 'x', type: 'photo', index: 0 }, {
      requestBody: async () => { calls++; return {}; },
    }), /MEDIA_PROXY_DENIED/);
  }
  assert.equal(calls, 0);
});

test('There is no direct media path: a missing proxy is denied before any connection', { timeout: 5000 }, async () => {
  let calls = 0;
  const overrides = { connect: () => { calls++; throw new Error('UNEXPECTED_DIRECT'); }, lookup: () => { calls++; throw new Error('UNEXPECTED_DNS'); } };
  await assert.rejects(connectMediaProxy('pbs.twimg.com', undefined, new globalThis.AbortController().signal, overrides), /MEDIA_PROXY_DENIED/);
  assert.equal(calls, 0);
});

test('Engine arguments and the resolver refuse an empty, missing or direct route', async context => {
  const selected = process.env.EGOIST_RELAY_MEDIA_PROXY;
  context.after(() => { process.env.EGOIST_RELAY_MEDIA_PROXY = selected; });
  const base = { nodePath: process.execPath, tempDir: path.dirname(process.execPath) };
  for (const route of [undefined, '', 'direct']) {
    process.env.EGOIST_RELAY_MEDIA_PROXY = route === undefined ? '' : route;
    assert.throws(() => createEngineArgs({ ...base, proxy: route }, 'metadata'), /MEDIA_PROXY_DENIED/);
    await assert.rejects(resolveMedia({ url: 'https://x.com/i/status/1234567890123456789', enginePath: path.resolve('engine.exe'), ...base, index: 0 }, {
      runEngine: async () => { throw new Error('UNEXPECTED_ENGINE'); },
    }), /MEDIA_PROXY_DENIED/);
  }
});

test('Direct redirects and response sizes retain the media boundary', { timeout: 5000 }, async context => {
  let mode = 'redirect';
  const port = await createTlsFixture(context, (request, response) => {
    if (mode === 'redirect') { response.writeHead(302, { location: 'https://127.0.0.1/private' }); response.end(); return; }
    response.writeHead(200, { 'content-length': 99 }); response.end(Buffer.from([0xff, 0xd8, 0xff]));
  });
  const input = { url: 'https://pbs.twimg.com/media/test.jpg', service: 'x', type: 'photo', index: 0, maxBytes: 16 };
  await assert.rejects(fetchMedia(input, createFixtureTransport(port)), /MEDIA_URL_DENIED/);
  mode = 'size';
  await assert.rejects(fetchMedia(input, createFixtureTransport(port)), /MEDIA_TOO_LARGE/);
});

test('Resolver download uses the selected OS proxy without repeated metadata extraction', { timeout: 5000, skip: !process.env.EGOIST_RELAY_AUDIT_WORK }, async context => {
  const tempDir = await fs.mkdtemp(path.join(process.env.EGOIST_RELAY_AUDIT_WORK, 'resolver-route-fixture-'));
  context.after(async () => {
    assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(process.env.EGOIST_RELAY_AUDIT_WORK));
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const requests = [];
  const port = await createTestServer(context, async socket => {
    const reader = createSocketReader(socket); requests.push((await reader.read()).toString()); reader.release();
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
  });
  useProxy(context, `http://127.0.0.1:${port}`);
  const phases = []; const routes = [];
  await assert.rejects(resolveMedia({ url: 'https://www.youtube.com/watch?v=abcdefghijk', enginePath: path.join(tempDir, 'synthetic-engine.exe'), nodePath: process.execPath, tempDir, index: 0 }, {
    runEngine: async (input, phase, url, signal) => {
      phases.push(phase);
      const arguments_ = createEngineArgs(input, phase); const route = arguments_[arguments_.indexOf('--proxy') + 1]; routes.push(route);
      const socket = await connectMediaProxy('www.youtube.com', parseMediaProxy(route), signal); socket.destroy();
      return phase === 'download' ? Buffer.alloc(0) : Buffer.from(JSON.stringify({ extractor_key: 'Youtube', duration: 1344 }));
    },
  }), /MEDIA_FORMAT_UNAVAILABLE/);
  assert.deepEqual(phases, ['download']); assert.equal(routes.length, 1); assert.match(routes[0], /^socks5h:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(requests.length, 1); for (const request of requests) assert.match(request, /^CONNECT www\.youtube\.com:443 HTTP\/1\.1/);
  assert.deepEqual(await fs.readdir(tempDir), []);
});

const TLS_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtxBtleVBxSD6MmX0
L0EmV4bPY4aPgdC6RQ921FuO3zWhRANCAATUXMYOHE34kKwS2iay97BqhvDaQxCP
TYcnKOpNGM+V4mn/j2pljOmLTcQKJYO9RrONoYiwxbFR5nlAhyJie/r3
-----END PRIVATE KEY-----`;
const TLS_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIByjCCAW+gAwIBAgIUCD3G4sYRG7WlDhxC2W1UEziUH28wCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNcGJzLnR3aW1nLmNvbTAeFw0yNjA5MzAxMTA1MjBaFw00NjA5
MjUxMTA1MjBaMBgxFjAUBgNVBAMMDXBicy50d2ltZy5jb20wWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAATUXMYOHE34kKwS2iay97BqhvDaQxCPTYcnKOpNGM+V4mn/
j2pljOmLTcQKJYO9RrONoYiwxbFR5nlAhyJie/r3o4GWMIGTMB0GA1UdDgQWBBSS
uTX8GTsFfT9t4G3Gj1GXSr+pFDAfBgNVHSMEGDAWgBSSuTX8GTsFfT9t4G3Gj1GX
Sr+pFDAPBgNVHRMBAf8EBTADAQH/MEAGA1UdEQQ5MDeCDXBicy50d2ltZy5jb22C
D3ZpZGVvLnR3aW1nLmNvbYIVdGVzdC5jZG5pbnN0YWdyYW0uY29tMAoGCCqGSM49
BAMCA0kAMEYCIQDN2H2BqHYQjF/x7eGcOZFaVK54bgqZL0NkcgeqyuaTOQIhAOTn
cO26uU241jZDV96mjk+VeAcU7KDwl8g7QH99vz3v
-----END CERTIFICATE-----`;
