import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { setImmediate as waitForImmediate } from 'node:timers/promises';

import { WebSocket } from 'ws';

import { createTelegramTransport } from './telegram-transport.mjs';

const ORIGIN = 'http://tauri.localhost';

function browserHandshake() {
  const header = randomBytes(64);
  header.writeUInt32LE(0xefefefef, 56);
  const reversed = Buffer.from(header.subarray(8, 56)).reverse();
  const decrypt = createDecipheriv('aes-256-ctr', reversed.subarray(0, 32), reversed.subarray(32, 48));
  const encrypt = createCipheriv('aes-256-ctr', header.subarray(8, 40), header.subarray(40, 56));
  encrypt.update(header).subarray(56, 64).copy(header, 56);
  return { header, decrypt };
}

function proxyResponseCipher(header, secret) {
  const reversed = Buffer.from(header.subarray(8, 56)).reverse();
  const key = createHash('sha256').update(reversed.subarray(0, 32)).update(Buffer.from(secret, 'hex')).digest();
  return createCipheriv('aes-256-ctr', key, reversed.subarray(32, 48));
}

async function flushSocketEvents() {
  for (let iteration = 0; iteration < 4; iteration++) await waitForImmediate();
}

async function withLocalConnection(context, run) {
  const connections = new Set();
  let resolveHeader;
  const receivedHeader = new Promise((resolve) => { resolveHeader = resolve; });
  const server = net.createServer((connection) => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.on('close', () => connections.delete(connection));
    let bytes = Buffer.alloc(0);
    connection.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 64) resolveHeader({ header: bytes.subarray(0, 64), connection });
    });
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let bridge;
  let webSocket;
  try {
    const settings = {
      token: randomBytes(32).toString('hex'),
      origins: [ORIGIN],
      localPort: server.address().port,
      localSecret: randomBytes(16).toString('hex'),
    };
    bridge = await createTelegramTransport(settings);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    webSocket = new WebSocket(`${bridge.url}&dc=3&media=1`, 'binary', { origin: ORIGIN });
    await once(webSocket, 'open');
    const browser = browserHandshake();
    webSocket.send(browser.header);
    const proxy = await receivedHeader;
    await run({
      webSocket,
      proxySocket: proxy.connection,
      encryptResponse: proxyResponseCipher(proxy.header, settings.localSecret),
      decryptResponse: browser.decrypt,
    });
  } finally {
    webSocket?.terminate();
    bridge?.close();
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    context.mock.timers.reset();
  }
}

test('own proxy can deliver its first encrypted response after the external 12-second budget', { timeout: 5000 }, async (context) => {
  await withLocalConnection(context, async ({ webSocket, proxySocket, encryptResponse, decryptResponse }) => {
    context.mock.timers.tick(12001);
    await flushSocketEvents();
    assert.equal(webSocket.readyState, WebSocket.OPEN);
    const response = new Promise((resolve, reject) => {
      webSocket.once('message', (data, isBinary) => resolve({ data, isBinary }));
      webSocket.once('close', () => reject(new Error('Own proxy closed before its first response')));
    });
    const plaintext = Buffer.from('local first response after cold start', 'utf8');
    proxySocket.write(encryptResponse.update(plaintext));
    const received = await response;
    assert.equal(received.isBinary, true);
    assert.deepEqual(decryptResponse.update(received.data), plaintext);
    context.mock.timers.tick(45000);
    await flushSocketEvents();
    assert.equal(webSocket.readyState, WebSocket.OPEN);
  });
});

test('own proxy without a first response closes exactly at its 45-second budget', { timeout: 5000 }, async (context) => {
  await withLocalConnection(context, async ({ webSocket }) => {
    context.mock.timers.tick(44999);
    await flushSocketEvents();
    assert.equal(webSocket.readyState, WebSocket.OPEN);
    const closed = once(webSocket, 'close');
    context.mock.timers.tick(1);
    await closed;
    assert.equal(webSocket.readyState, WebSocket.CLOSED);
  });
});
