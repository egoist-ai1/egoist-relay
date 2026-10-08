// Parallel provider slots of the research helper, checked against the real helper module and a real named pipe.
// Windows only: the helper prepares a private state directory with the bundled PowerShell script.
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const skip = process.platform !== 'win32';

function hmac(token, text) {
  return createHmac('sha256', token).update(text, 'utf8').digest('hex');
}

// One request per connection, with the hello proof checked like the daemon does
function connect(metadata, token, method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(metadata.pipePath);
    const id = randomUUID();
    const challenge = randomBytes(32).toString('hex');
    const events = [];
    let buffered = '';
    let waiters = [];
    const notify = () => { const pending = waiters; waiters = []; pending.forEach((resume) => resume()); };
    socket.on('error', reject);
    socket.on('close', notify);
    socket.once('connect', () => socket.write(JSON.stringify({ id, challenge, method: 'hello' }) + '\n'));
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        const event = frame.event;
        if (event.kind === 'hello') {
          assert.equal(event.proof, hmac(token, `${id}\n${challenge}\n${event.nonce}\n${metadata.runtimeId}\n${metadata.appPid}\n${metadata.helperPid}`));
          const mac = hmac(token, `${id}\n${challenge}\n${event.nonce}\n${metadata.runtimeId}\n${method}\n${JSON.stringify(params)}`);
          socket.write(JSON.stringify({ id, challenge, method, params, mac }) + '\n');
        } else {
          events.push(event);
          notify();
        }
      }
    });
    resolve({
      socket, events,
      async next(predicate = () => true) {
        for (let attempt = 0; attempt < 200; attempt++) {
          const found = events.find(predicate);
          if (found) return found;
          await new Promise((resume) => { waiters.push(resume); setTimeout(resume, 50); });
        }
        throw new Error('NO_EVENT');
      },
    });
  });
}

const run = (provider, jobId) => ({
  provider, operation: 'channel_history', input: { channel: 'example', limit: 1 }, jobId,
  expectedAccount: { accountRef: 'account', accountEpoch: 'epoch' },
});

test('telegram accepts three simultaneous runs, other providers one', { skip, timeout: 60000 }, async (context) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-parallel-'));
  process.env.EGOIST_RELAY_SMOKE_TEST = '1';
  process.env.EGOIST_RELAY_TEST_PROFILE = profile;
  const { startBridge } = await import(pathToFileURL(path.join(root, 'runtime/research/bridge-server.mjs')).href);
  const dispatched = [];
  const stateRoot = path.join(profile, 'research');
  const bridge = await startBridge({
    type: 'init', protocolVersion: 1, runtimeId: randomUUID(), appPid: process.ppid, appStartedAt: Date.now(),
    executablePath: process.execPath, stateRoot, isolatedTest: true,
  }, (frame) => dispatched.push(frame));
  context.after(() => { bridge.close(); });
  const token = fs.readFileSync(path.join(stateRoot, 'relay-bridge-token'), 'utf8');
  const sockets = [];
  try {
    for (let index = 1; index <= 3; index++) {
      sockets.push(await connect(bridge.metadata, token, 'run', run('telegram', `tg-${index}`)));
    }
    for (let attempt = 0; attempt < 100 && dispatched.filter((frame) => frame.type === 'request').length < 3; attempt++) {
      await new Promise((resume) => setTimeout(resume, 50));
    }
    assert.equal(dispatched.filter((frame) => frame.type === 'request' && frame.provider === 'telegram').length, 3);

    const fourth = await connect(bridge.metadata, token, 'run', run('telegram', 'tg-4'));
    const refused = await fourth.next((event) => event.kind === 'error');
    assert.equal(refused.code, 'PROVIDER_BUSY');
    assert.equal(dispatched.filter((frame) => frame.type === 'request').length, 3);

    // Closing one run frees its slot for a new one
    sockets[0].socket.destroy();
    for (let attempt = 0; attempt < 100 && !dispatched.some((frame) => frame.type === 'cancel'); attempt++) {
      await new Promise((resume) => setTimeout(resume, 50));
    }
    const replacement = await connect(bridge.metadata, token, 'run', run('telegram', 'tg-5'));
    for (let attempt = 0; attempt < 100 && dispatched.filter((frame) => frame.type === 'request').length < 4; attempt++) {
      await new Promise((resume) => setTimeout(resume, 50));
    }
    assert.equal(dispatched.filter((frame) => frame.type === 'request' && frame.jobId === 'tg-5').length, 1);
    sockets.push(replacement);

    // X keeps its single slot
    sockets.push(await connect(bridge.metadata, token, 'run', run('x', 'x-1')));
    const secondX = await connect(bridge.metadata, token, 'run', run('x', 'x-2'));
    assert.equal((await secondX.next((event) => event.kind === 'error')).code, 'PROVIDER_BUSY');
    // A job identifier is never reused while it is open
    const duplicate = await connect(bridge.metadata, token, 'run', run('telegram', 'tg-2'));
    assert.equal((await duplicate.next((event) => event.kind === 'error')).code, 'PROVIDER_BUSY');
  } finally {
    sockets.forEach(({ socket }) => socket.destroy());
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
