import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { createTelegramTransport } from './telegram-transport.mjs';

const ORIGIN = 'http://tauri.localhost';

async function listen(onConnection = () => {}) {
  const server = net.createServer(onConnection);
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  return server;
}

function settings(localPort) {
  return { token: randomBytes(32).toString('hex'), origins: [ORIGIN], localPort, localSecret: randomBytes(16).toString('hex') };
}

function browserHeader() {
  const header = randomBytes(64);
  header.writeUInt32LE(0xefefefef, 56);
  const cipher = createCipheriv('aes-256-ctr', header.subarray(8, 40), header.subarray(40, 56));
  const encrypted = cipher.update(header);
  encrypted.copy(header, 56, 56);
  return header;
}

test('own loopback MTProxy is reached directly and receives the negative media DC', async () => {
  let resolveHeader;
  const received = new Promise((resolve) => { resolveHeader = resolve; });
  const server = await listen((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 64) resolveHeader(bytes.subarray(0, 64));
    });
  });
  const config = settings(server.address().port);
  const bridge = await createTelegramTransport(config);
  const socket = new WebSocket(`${bridge.url}&dc=4&media=1&premium=1`, 'binary', { origin: ORIGIN });
  try {
    await once(socket, 'open');
    socket.send(browserHeader());
    const header = await received;
    const key = createHash('sha256').update(header.subarray(8, 40)).update(Buffer.from(config.localSecret, 'hex')).digest();
    const decoded = createDecipheriv('aes-256-ctr', key, header.subarray(40, 56)).update(header);
    assert.equal(decoded.readUInt32LE(56), 0xefefefef);
    assert.equal(decoded.readInt16LE(60), -4);
  } finally {
    socket.terminate();
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an unavailable own proxy refuses the upgrade and recovers on the same bridge URL', async () => {
  const reserved = await listen();
  const localPort = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const bridge = await createTelegramTransport(settings(localPort));
  let server;
  try {
    const failed = new WebSocket(`${bridge.url}&dc=2`, 'binary', { origin: ORIGIN });
    failed.on('error', () => {});
    const [, response] = await once(failed, 'unexpected-response');
    response.resume();
    failed.terminate();
    assert.equal(response.statusCode, 503);
    server = net.createServer((socket) => { socket.on('error', () => {}); });
    server.listen({ host: '127.0.0.1', port: localPort });
    await once(server, 'listening');
    const recovered = new WebSocket(`${bridge.url}&dc=2`, 'binary', { origin: ORIGIN });
    await once(recovered, 'open');
    recovered.terminate();
  } finally {
    bridge.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test('local bootstrap rejects mixed tunnel configuration and malformed secrets', async () => {
  const config = settings(31000);
  for (const invalid of [
    { ...config, localPort: 80 },
    { ...config, localSecret: 'invalid' },
    { ...config, socksPort: 31001 },
    { ...config, mtproxy: 'tg://proxy?server=example.test' },
  ]) {
    await assert.rejects(createTelegramTransport(invalid), (error) => error.code === 'INVALID_BOOTSTRAP'
      && !error.message.includes(config.localSecret));
  }
});
