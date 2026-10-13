import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import net from 'node:net';
import test from 'node:test';

import { WebSocket } from 'ws';

import { createTelegramTransport, parseMtproxyLink } from './telegram-transport.mjs';

// Тесты идут только по loopback: поддельный SOCKS5 туннеля и поддельный MTProxy со случайным secret; живые сети не затрагиваются.
const ORIGIN = 'http://tauri.localhost';
const token = randomBytes(32).toString('hex');
const SECRET_HEX = randomBytes(16).toString('hex');
const LINK = `tg://proxy?server=mtproxy.example.test&port=8443&secret=dd${SECRET_HEX}`;

/**
 * Поддельный SOCKS5 туннеля без авторизации: запоминает запрошенные тип адреса, имя и порт,
 * затем соединяет с `targetPort`. `refuse` отвечает кодом 5 (connection refused).
 */
function startSocks(targetPort, { refuse = false } = {}) {
  const requests = [];
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      let stage = 'greeting';
      let buffered = Buffer.alloc(0);
      client.on('error', () => {});
      client.on('data', function onData(chunk) {
        buffered = Buffer.concat([buffered, chunk]);
        if (stage === 'greeting' && buffered.length >= 3) {
          buffered = buffered.subarray(3);
          client.write(Buffer.from([5, 0]));
          stage = 'request';
        }
        if (stage === 'request' && buffered.length >= 5) {
          const kind = buffered[3];
          const length = kind === 3 ? 5 + buffered[4] + 2 : kind === 1 ? 10 : 22;
          if (buffered.length < length) return;
          const host = kind === 3 ? buffered.toString('ascii', 5, 5 + buffered[4]) : undefined;
          requests.push({ kind, host, port: buffered.readUInt16BE(length - 2) });
          stage = 'piped';
          client.removeListener('data', onData);
          if (refuse) {
            client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on('error', () => client.destroy());
          client.on('close', () => upstream.destroy());
        }
      });
    });
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve({ server, requests, port: server.address().port }));
  });
}

function startBridge(socks, overrides = {}) {
  return createTelegramTransport({
    token, origins: [ORIGIN], port: 0, socksPort: socks.port, mtproxy: LINK, ...overrides,
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.ok(!String(error.message).includes(SECRET_HEX));
    return true;
  });
}

function listen(onConnection) {
  return new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve(server));
  });
}

function getFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Заголовок obfuscated2, который мост принимает: тег протокола после расшифровки AES-CTR. */
function createBrowserHeader() {
  const header = randomBytes(64);
  const keystream = createDecipheriv('aes-256-ctr', header.subarray(8, 40), header.subarray(40, 56)).update(Buffer.alloc(64));
  const tag = Buffer.from('efefefef', 'hex');
  for (let index = 0; index < 4; index++) header[56 + index] = keystream[56 + index] ^ tag[index];
  return header;
}

function connect(url) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = new WebSocket(url, 'binary', { origin: ORIGIN });
    socket.on('open', () => resolve({ socket, opened: true, ms: Date.now() - startedAt }));
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve({ opened: false, status: response.statusCode, ms: Date.now() - startedAt });
    });
    socket.on('error', () => resolve({ opened: false, ms: Date.now() - startedAt }));
  });
}

test('WebSocket opens only after MTProxy is reached through SOCKS by name, and the header is forwarded', async () => {
  const received = [];
  const mtproxy = await listen((socket) => socket.on('data', (chunk) => received.push(chunk)));
  const socks = await startSocks(mtproxy.address().port);
  const transport = await startBridge(socks);
  try {
    const result = await connect(`${transport.url}&dc=2`);
    assert.equal(result.opened, true);
    assert.deepEqual(socks.requests, [{ kind: 3, host: 'mtproxy.example.test', port: 8443 }],
      'the name must go to SOCKS as a string (socks5h) before the upgrade completes');
    result.socket.send(createBrowserHeader());
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(Buffer.concat(received).length, 64);
    result.socket.close();
  } finally {
    transport.close();
    socks.server.close();
    mtproxy.close();
  }
});

test('refused SOCKS CONNECT gives 503 instead of a dead open socket', async () => {
  const socks = await startSocks(1, { refuse: true });
  const transport = await startBridge(socks);
  try {
    const result = await connect(`${transport.url}&dc=2`);
    assert.equal(result.opened, false);
    assert.equal(result.status, 503);
    assert.ok(result.ms < 4500, `failed after ${result.ms}ms; the client waits 5000ms for the bridge`);
  } finally {
    transport.close();
    socks.server.close();
  }
});

test('a closed SOCKS port gives 503 without killing the bridge', async () => {
  const transport = await startBridge({ port: await getFreePort() });
  try {
    assert.equal((await connect(`${transport.url}&dc=2`)).status, 503);
    assert.equal((await connect(`${transport.url}&dc=3`)).status, 503);
  } finally {
    transport.close();
  }
});

test('requests with a wrong token or origin are still rejected', async () => {
  const mtproxy = await listen(() => undefined);
  const socks = await startSocks(mtproxy.address().port);
  const transport = await startBridge(socks);
  try {
    const wrongToken = transport.url.replace(token, randomBytes(32).toString('hex'));
    assert.equal((await connect(`${wrongToken}&dc=2`)).status, 403);
    assert.equal((await connect(`${transport.url}&dc=9`)).status, 403);
  } finally {
    transport.close();
    socks.server.close();
    mtproxy.close();
  }
});

test('config errors have stable codes and never contain the secret', async () => {
  const socks = { port: 1 };
  await expectCode(startBridge(socks, { mtproxy: undefined }), 'MTPROXY_NOT_CONFIGURED');
  await expectCode(startBridge(socks, { mtproxy: '' }), 'MTPROXY_NOT_CONFIGURED');
  await expectCode(startBridge({}), 'TUNNEL_SOCKS_MISSING');
  await expectCode(startBridge(socks, { mtproxy: `https://example.com/proxy?server=a.test&port=1&secret=${SECRET_HEX}` }),
    'MTPROXY_INVALID_LINK');
  await expectCode(startBridge(socks, { mtproxy: `tg://proxy?server=a.test&port=443&secret=${SECRET_HEX.slice(2)}` }),
    'MTPROXY_INVALID_SECRET');
  const domain = Buffer.from('example.com').toString('hex');
  await expectCode(startBridge(socks, { mtproxy: `tg://proxy?server=a.test&port=443&secret=ee${SECRET_HEX}${domain}` }),
    'MTPROXY_FAKETLS_UNSUPPORTED');
});

test('loopback MTProxy (the local Lagom proxy) is rejected', async () => {
  for (const server of ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]', '0.0.0.0']) {
    await expectCode(startBridge({ port: 1 }, {
      mtproxy: `tg://proxy?server=${encodeURIComponent(server)}&port=1443&secret=dd${SECRET_HEX}`,
    }), 'MTPROXY_LOOPBACK_UNSUPPORTED');
  }
});

test('parseMtproxyLink understands tg:// and t.me links, hex dd/ee and base64url secrets', () => {
  const key = Buffer.from(SECRET_HEX, 'hex');
  const plain = parseMtproxyLink(`tg://proxy?server=a.example&port=443&secret=${SECRET_HEX}`);
  assert.deepEqual([plain.host, plain.port, plain.mode], ['a.example', 443, 'plain']);
  assert.ok(plain.secret.equals(key));
  const padded = parseMtproxyLink(`https://t.me/proxy?server=1.2.3.4&port=8443&secret=dd${SECRET_HEX}`);
  assert.deepEqual([padded.host, padded.port, padded.mode], ['1.2.3.4', 8443, 'dd']);
  assert.ok(padded.secret.equals(key));
  const domain = Buffer.from('example.com').toString('hex');
  const faketls = parseMtproxyLink(`tg://proxy?server=a.example&port=443&secret=ee${SECRET_HEX}${domain}`);
  assert.equal(faketls.mode, 'faketls');
  assert.ok(faketls.secret.equals(key));
  const encoded = Buffer.concat([Buffer.from([0xdd]), key]).toString('base64url');
  const base64 = parseMtproxyLink(`tg://proxy?server=a.example&port=443&secret=${encoded}`);
  assert.equal(base64.mode, 'dd');
  assert.ok(base64.secret.equals(key));
  assert.equal(parseMtproxyLink(`tg://proxy?server=%5B2001%3Adb8%3A%3A1%5D&port=443&secret=${SECRET_HEX}`).host, '2001:db8::1');
});

test('SOCKS CONNECT for IPv4 and IPv6 MTProxy hosts uses address types, not names', async () => {
  const mtproxy = await listen(() => undefined);
  const socks = await startSocks(mtproxy.address().port);
  try {
    for (const [server, kind] of [['203.0.113.7', 1], ['2001:db8::1', 4]]) {
      const transport = await startBridge(socks, {
        mtproxy: `tg://proxy?server=${encodeURIComponent(server)}&port=443&secret=dd${SECRET_HEX}`,
      });
      const result = await connect(`${transport.url}&dc=2`);
      assert.equal(result.opened, true);
      assert.equal(socks.requests.at(-1).kind, kind);
      result.socket.close();
      transport.close();
    }
  } finally {
    socks.server.close();
    mtproxy.close();
  }
});

/** Сырой HTTP Upgrade без ws-клиента, чтобы оборвать соединение RST'ом в нужный момент. */
function sendRawUpgrade(transport, search) {
  const { port } = new URL(transport.url);
  const url = new URL(transport.url);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) }, () => {
      socket.write([
        `GET /apiws${search ?? url.search}&dc=2 HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
        `Origin: ${ORIGIN}`, 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Protocol: binary',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, '', '',
      ].join('\r\n'));
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

test('RST of the raw socket while waiting for the SOCKS tunnel does not kill the bridge', async () => {
  // SOCKS молчит (принимает соединение, но не отвечает): upgrade ждёт openProxy, и в это время клиент рвёт соединение
  const silent = await listen(() => undefined);
  const transport = await startBridge({ port: silent.address().port });
  let failure;
  const onUncaught = (error) => { failure = error; };
  process.on('uncaughtException', onUncaught);
  try {
    for (let index = 0; index < 3; index++) {
      const raw = await sendRawUpgrade(transport);
      raw.on('error', () => {});
      await new Promise((resolve) => setTimeout(resolve, 30));
      raw.resetAndDestroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(failure, undefined, `bridge raised ${failure?.code}`);
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    transport.close();
    silent.close();
  }
});

test('RST after a 403 does not kill the bridge', async () => {
  const mtproxy = await listen(() => undefined);
  const socks = await startSocks(mtproxy.address().port);
  const transport = await startBridge(socks);
  let failure;
  const onUncaught = (error) => { failure = error; };
  process.on('uncaughtException', onUncaught);
  try {
    for (let index = 0; index < 5; index++) {
      const raw = await sendRawUpgrade(transport, `?token=${randomBytes(32).toString('hex')}`);
      raw.on('error', () => {});
      raw.resetAndDestroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(failure, undefined, `bridge raised ${failure?.code}`);
    const result = await connect(`${transport.url}&dc=2`);
    assert.equal(result.opened, true);
    result.socket.close();
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    transport.close();
    socks.server.close();
    mtproxy.close();
  }
});
