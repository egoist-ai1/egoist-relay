import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { createTelegramTransport } from './telegram-transport.mjs';

// Тесты идут только по loopback с поддельным Lagom и случайным тестовым secret; живые сети и реальный Lagom не затрагиваются.
const ORIGIN = 'http://tauri.localhost';
const token = randomBytes(32).toString('hex');
const previousProgramData = process.env.ProgramData;
let root;

test.before(() => {
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'relay-transport-')));
  process.env.ProgramData = root;
});
test.after(() => {
  if (previousProgramData === undefined) delete process.env.ProgramData; else process.env.ProgramData = previousProgramData;
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(port) {
  const directory = path.join(root, 'EgoistShield', 'Runtime', 'TelegramProxy');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port, secret: randomBytes(16).toString('hex'),
  }));
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

test('WebSocket opens only after Lagom TCP is reached and the header is forwarded to it', async () => {
  const received = [];
  let accepted = 0;
  const lagom = await listen((socket) => {
    accepted++;
    socket.on('data', (chunk) => received.push(chunk));
  });
  writeConfig(lagom.address().port);
  const transport = await createTelegramTransport({ token, origins: [ORIGIN], port: 0 });
  try {
    assert.equal(transport.reason, undefined);
    const acceptedBefore = accepted;
    const result = await connect(`${transport.url}&dc=2`);
    assert.equal(result.opened, true);
    assert.equal(accepted - acceptedBefore, 1, 'Lagom must be connected before the WebSocket upgrade completes');
    result.socket.send(createBrowserHeader());
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(Buffer.concat(received).length, 64);
    result.socket.close();
  } finally {
    transport.close();
    lagom.close();
  }
});

test('unavailable Lagom gives an immediate 503 instead of a dead open socket', async () => {
  writeConfig(await getFreePort());
  const transport = await createTelegramTransport({ token, origins: [ORIGIN], port: 0 });
  try {
    assert.equal(transport.reason, 'LAGOM_LISTENER_UNAVAILABLE');
    const result = await connect(`${transport.url}&dc=2`);
    assert.equal(result.opened, false);
    assert.equal(result.status, 503);
    assert.ok(result.ms < 2500, `failed after ${result.ms}ms; client falls back to the direct route at 2500ms`);
  } finally {
    transport.close();
  }
});

test('bridge recovers when Lagom returns without restarting', async () => {
  const port = await getFreePort();
  writeConfig(port);
  const transport = await createTelegramTransport({ token, origins: [ORIGIN], port: 0 });
  try {
    assert.equal((await connect(`${transport.url}&dc=2`)).opened, false);
    const lagom = await new Promise((resolve) => {
      const server = net.createServer();
      server.listen({ host: '127.0.0.1', port }, () => resolve(server));
    });
    const result = await connect(`${transport.url}&dc=2`);
    assert.equal(result.opened, true);
    result.socket.close();
    lagom.close();
  } finally {
    transport.close();
  }
});

test('requests with a wrong token or origin are still rejected', async () => {
  const lagom = await listen(() => undefined);
  writeConfig(lagom.address().port);
  const transport = await createTelegramTransport({ token, origins: [ORIGIN], port: 0 });
  try {
    const wrongToken = transport.url.replace(token, randomBytes(32).toString('hex'));
    assert.equal((await connect(`${wrongToken}&dc=2`)).status, 403);
    assert.equal((await connect(`${transport.url}&dc=9`)).status, 403);
  } finally {
    transport.close();
    lagom.close();
  }
});
