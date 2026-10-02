import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http2 from 'node:http2';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { resolveMedia } from './inline-media-resolver.mjs';
import { fetchMedia } from './social-media-fetch.mjs';

const MIB = 1024 * 1024;
const metrics = [];
const previousProxy = process.env.EGOIST_RELAY_MEDIA_PROXY;
const root = process.env.EGOIST_RELAY_AUDIT_WORK;
const key = process.env.EGOIST_RELAY_TEST_TLS_KEY;
const cert = process.env.EGOIST_RELAY_TEST_TLS_CERT;
const hasTlsFixture = Boolean(key && cert);

test.before(async () => {
  assert.ok(root && path.isAbsolute(root), 'Set EGOIST_RELAY_AUDIT_WORK to this task own work directory');
  assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
  assert.equal((await fs.realpath(root)).replace(/^\\\?\\/, '').toLowerCase(), path.resolve(root).toLowerCase());
  process.env.EGOIST_RELAY_MEDIA_PROXY = 'direct';
});
test.after(async () => {
  if (previousProxy === undefined) delete process.env.EGOIST_RELAY_MEDIA_PROXY;
  else process.env.EGOIST_RELAY_MEDIA_PROXY = previousProxy;
  if (root) await fs.writeFile(path.join(root, 'file-channel-metrics.json'), JSON.stringify({ synthetic: true, metrics }, undefined, 2));
});

async function createDirectory(context) {
  const directory = await fs.mkdtemp(path.join(root, 'media-file-audit-'));
  context.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(root));
    const stat = await fs.lstat(resolved);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal((await fs.realpath(resolved)).replace(/^\\\?\\/, '').toLowerCase(), resolved.toLowerCase());
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

async function createServer(context, handle) {
  const sockets = new Set();
  const server = http2.createSecureServer({ key, cert, allowHTTP1: true });
  server.on('request', (request, response) => { void Promise.resolve(handle(request, response)).catch(() => response.destroy()); });
  server.on('sessionError', () => {});
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

function createTransport(port, alpn) {
  return {
    lookup: (hostname, options, callback) => {
      assert.equal(hostname, 'pbs.twimg.com');
      assert.equal(options.all, true);
      globalThis.queueMicrotask(() => callback(undefined, [{ address: '1.1.1.1', family: 4 }]));
    },
    connect: options => {
      assert.equal(options.host, 'pbs.twimg.com');
      assert.equal(options.port, 443);
      const socket = new net.Socket();
      options.lookup(options.host, { all: true }, error => {
        if (error) socket.destroy(error);
        else socket.connect({ host: '127.0.0.1', port, signal: options.signal });
      });
      return socket;
    },
    connectTls: options => {
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.servername, 'pbs.twimg.com');
      return tls.connect({ ...options, ca: cert, ALPNProtocols: [alpn] });
    },
  };
}

function createInput(tempDir) {
  return { url: 'https://pbs.twimg.com/media/synthetic.jpg', service: 'x', type: 'photo', index: 0, outputMode: 'file', tempDir };
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

for (const alpn of ['http/1.1', 'h2']) {
  test(`70 MiB original file streams byte-exactly over verified ${alpn} with one GET`, { timeout: 30000, skip: !hasTlsFixture }, async context => {
    const directory = await createDirectory(context);
    const size = 70 * MIB + 13;
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const prefix = Buffer.from([0xff, 0xd8, 0xff, 0x5a]);
    const expectedHash = createHash('sha256');
    let requests = 0;
    const port = await createServer(context, async (request, response) => {
      requests++;
      assert.equal(request.method, 'GET');
      response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': size });
      expectedHash.update(prefix);
      response.write(prefix);
      let remaining = size - prefix.length;
      while (remaining) {
        const bytes = chunk.subarray(0, Math.min(chunk.length, remaining));
        expectedHash.update(bytes);
        if (!response.write(bytes)) await once(response, 'drain');
        remaining -= bytes.length;
      }
      response.end();
    });
    const started = performance.now();
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sampling = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
    let result;
    try { result = await fetchMedia({ ...createInput(directory), maxBytes: 1 }, createTransport(port, alpn)); }
    finally { clearInterval(sampling); }
    assert.equal(requests, 1);
    assert.equal(result.body, undefined);
    assert.equal(result.metadata.size, size);
    assert.equal((await fs.stat(result.filePath)).size, size);
    assert.equal(await hashFile(result.filePath), expectedHash.digest('hex'));
    metrics.push({ scenario: 'stream-original', alpn, bytes: size, gets: requests, elapsedMs: performance.now() - started, rssDeltaBytes: peakRss - baselineRss, signature: 'synthetic JPEG prefix; byte-stream fixture, not a playable photo' });
  });
}

for (const alpn of ['http/1.1', 'h2']) {
  test(`A truncated ${alpn} original is rejected and removes its partial file`, { timeout: 5000, skip: !hasTlsFixture }, async context => {
    const directory = await createDirectory(context);
    const port = await createServer(context, async (request, response) => {
      response.writeHead(200, { 'content-length': MIB });
      response.write(Buffer.from([0xff, 0xd8, 0xff]));
      await new Promise(resolve => setTimeout(resolve, 20));
      response.destroy();
    });
    await assert.rejects(fetchMedia(createInput(directory), createTransport(port, alpn)), /MEDIA_PARTIAL_BODY|MEDIA_CONNECTION_FAILED|aborted$/);
    const started = performance.now();
    while ((await fs.readdir(directory)).length && performance.now() - started < 1000) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(await fs.readdir(directory), []);
  });
}

test('A depleted disk budget rejects an original before opening its CDN transport', async context => {
  const directory = await createDirectory(context);
  const mocked = context.mock.method(fs, 'statfs', async () => ({ bavail: 32 * 1024, bsize: 1024 }));
  let requests = 0;
  await assert.rejects(fetchMedia(createInput(directory), { requestBody: async () => { requests++; throw new Error('UNEXPECTED_GET'); } }), /MEDIA_DISK_FULL/);
  assert.equal(requests, 0);
  assert.deepEqual(await fs.readdir(directory), []);
  mocked.mock.restore();
});

test('Resolver depleted disk budget rejects before engine or metadata execution', async context => {
  const directory = await createDirectory(context);
  const mocked = context.mock.method(fs, 'statfs', async () => ({ bavail: 32 * 1024, bsize: 1024 }));
  let executions = 0;
  await assert.rejects(resolveMedia({ url: 'https://x.com/i/status/1234567890123456789', enginePath: path.join(directory, 'synthetic-engine.exe'), nodePath: process.execPath, tempDir: directory, index: 0, outputMode: 'file' }, {
    runEngine: async () => { executions++; throw new Error('UNEXPECTED_ENGINE'); },
  }), /MEDIA_DISK_FULL/);
  assert.equal(executions, 0);
  assert.deepEqual(await fs.readdir(directory), []);
  mocked.mock.restore();
});

function runProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { if (error.length < 4096) error += chunk; });
    child.once('error', reject);
    child.once('close', code => { if (code) reject(new Error(`FIXTURE_PROCESS_FAILED:${code}:${error}`)); else resolve(output); });
  });
}

test('An actual 1080p 1210-second local MP4 resolves losslessly through original-file mode', { timeout: 120000 }, async context => {
  const directory = await createDirectory(context);
  const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const ffmpegPath = path.join(project, 'runtime', 'media', 'ffmpeg.exe');
  const ffprobePath = path.join(project, 'runtime', 'media', 'ffprobe.exe');
  assert.ok((await fs.stat(ffmpegPath)).isFile());
  assert.ok((await fs.stat(ffprobePath)).isFile());
  const sourcePath = path.join(directory, 'generated-fullhd.mp4');
  await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=1/10', '-t', '1210', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-n', sourcePath]);
  const probe = JSON.parse(await runProcess(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type,codec_name', '-of', 'json', sourcePath]));
  assert.ok(probe.streams.some(stream => stream.width === 1920 && stream.height === 1080 && stream.codec_type === 'video'));
  const duration = Number(probe.format.duration);
  assert.ok(duration >= 1200);
  let enginePhases = [];
  const result = await resolveMedia({ url: 'https://x.com/i/status/1234567890123456789', enginePath: path.join(directory, 'synthetic-engine.exe'), nodePath: process.execPath, ffmpegPath, tempDir: directory, index: 0, outputMode: 'file' }, {
    runEngine: async (input, phase) => {
      enginePhases.push(phase);
      await fs.copyFile(sourcePath, path.join(directory, 'media.mp4'));
      return Buffer.from(JSON.stringify({ extractor_key: 'Twitter', duration, formats: [{ ext: 'mp4', vcodec: 'h264' }] }));
    },
  });
  assert.deepEqual(enginePhases, ['download']);
  assert.equal(result.body, undefined);
  assert.equal(await hashFile(result.filePath), await hashFile(sourcePath));
  metrics.push({ scenario: 'actual-local-mp4-file-channel', width: 1920, height: 1080, durationSeconds: duration, size: (await fs.stat(result.filePath)).size, codec: probe.streams.find(stream => stream.codec_type === 'video').codec_name, engine: 'synthetic observed metadata/copy; real bundled ffmpeg generation and real resolver ffprobe validation' });
});

for (const alpn of ['http/1.1', 'h2']) {
  test(`A ${alpn} declared original exceeding free disk budget reports disk space`, { timeout: 5000 }, async context => {
    const directory = await createDirectory(context);
    const mocked = context.mock.method(fs, 'statfs', async () => ({ bavail: 64 * MIB + 16, bsize: 1 }));
    const port = await createServer(context, (request, response) => {
      response.writeHead(200, { 'content-length': 100 });
      response.end(Buffer.from([0xff, 0xd8, 0xff, 0x5a]));
    });
    await assert.rejects(fetchMedia(createInput(directory), createTransport(port, alpn)), /MEDIA_DISK_FULL/);
    assert.deepEqual(await fs.readdir(directory), []);
    mocked.mock.restore();
  });
}

test('An original resolver file exceeding free disk budget reports disk space', async context => {
  const directory = await createDirectory(context);
  const mocked = context.mock.method(fs, 'statfs', async () => ({ bavail: 64 * MIB + 16, bsize: 1 }));
  await assert.rejects(resolveMedia({ url: 'https://x.com/i/status/1234567890123456789', enginePath: path.join(directory, 'synthetic-engine.exe'), nodePath: process.execPath, tempDir: directory, index: 0, outputMode: 'file' }, {
    runEngine: async () => {
      const bytes = Buffer.alloc(64); bytes.write('ftypisom', 4, 'ascii');
      await fs.writeFile(path.join(directory, 'media.mp4'), bytes);
      return Buffer.from(JSON.stringify({ extractor_key: 'Twitter', duration: 1 }));
    },
  }), /MEDIA_DISK_FULL/);
  assert.deepEqual(await fs.readdir(directory), []);
  mocked.mock.restore();
});

for (const alpn of ['http/1.1', 'h2']) {
  test(`Buffered ${alpn} size rejection retains its existing preview classification`, { timeout: 5000, skip: !hasTlsFixture }, async context => {
    const port = await createServer(context, (request, response) => {
      response.writeHead(200, { 'content-length': 100 });
      response.end(Buffer.from([0xff, 0xd8, 0xff, 0x5a]));
    });
    await assert.rejects(fetchMedia({ url: 'https://pbs.twimg.com/media/synthetic.jpg', service: 'x', type: 'photo', index: 0, maxBytes: 2 }, createTransport(port, alpn)), /MEDIA_TOO_LARGE/);
  });
}

test('Malformed HTTP2 length is rejected before any original file is created', { timeout: 5000, skip: !hasTlsFixture }, async context => {
  const directory = await createDirectory(context);
  const port = await createServer(context, (request, response) => {
    response.writeHead(200, { 'content-length': 'broken' });
    response.end(Buffer.from([0xff, 0xd8, 0xff, 0x5a]));
  });
  await assert.rejects(fetchMedia(createInput(directory), createTransport(port, 'h2')), /MEDIA_TOO_LARGE|MEDIA_PARTIAL_BODY|MEDIA_CONNECTION_FAILED/);
  assert.deepEqual(await fs.readdir(directory), []);
});