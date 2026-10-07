import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { classifyMediaHttpError, fetchMedia, validateMediaUrl } from './social-media-fetch.mjs';
import { canonicalizeMediaUrl, createEngineArgs, resolveMedia, runEngine, serializeCookies } from './inline-media-resolver.mjs';

const photo = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
const input = { url: 'https://pbs.twimg.com/media/test.jpg', service: 'x', type: 'photo', index: 0 };
const previousProxy = process.env.EGOIST_RELAY_MEDIA_PROXY;
test.before(() => { process.env.EGOIST_RELAY_MEDIA_PROXY = 'direct'; });
test.after(() => { if (previousProxy === undefined) delete process.env.EGOIST_RELAY_MEDIA_PROXY; else process.env.EGOIST_RELAY_MEDIA_PROXY = previousProxy; });

for (const [status, expected] of [[401, 'MEDIA_AUTH_REQUIRED'], [403, 'MEDIA_HTTP_FORBIDDEN'], [404, 'MEDIA_UNAVAILABLE'], [410, 'MEDIA_UNAVAILABLE'], [429, 'MEDIA_RATE_LIMITED'], [500, 'MEDIA_FETCH_FAILED'], [503, 'MEDIA_FETCH_FAILED'], [502, 'MEDIA_FETCH_FAILED'], [418, 'MEDIA_HTTP_FAILED']]) {
  test(`CDN rejection ${status} reports ${expected}`, () => {
    assert.equal(classifyMediaHttpError(status), expected);
  });
}

test('CDN fetching passes only the explicit route to its transport', async () => {
  let hasResolvedLocally = false;
  const result = await fetchMedia(input, {
    lookup: async () => { hasResolvedLocally = true; throw new Error('LOCAL_DNS_USED'); },
    requestBody: async (url, proxy) => { assert.equal(proxy, undefined); return { body: photo }; },
  });
  assert.equal(hasResolvedLocally, false);
  assert.equal(result.metadata.size, photo.length);
});

test('A legacy proxyPort never replaces an explicit direct route', async () => {
  const result = await fetchMedia({ ...input, proxyPort: 23333 }, {
    requestBody: async (url, proxy) => { assert.equal(proxy, undefined); return { body: photo }; },
  });
  assert.equal(result.metadata.size, photo.length);
});

test('CDN redirects retain the provider allowlist', async () => {
  await assert.rejects(fetchMedia(input, {
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
    requestBody: async () => ({ redirect: 'https://127.0.0.1/private' }),
  }), /MEDIA_URL_DENIED/);
});

test('CDN URLs reject normalization of control characters', () => {
  assert.throws(() => validateMediaUrl('https://pbs.twimg.com/\nmedia/test.jpg', 'x'), /MEDIA_URL_DENIED/);
});

test('Public resolver accepts the same Instagram forms as the UI', () => {
  assert.equal(canonicalizeMediaUrl('https://www.instagram.com/reels/AbCdE12345/').url, 'https://www.instagram.com/reel/AbCdE12345/');
  assert.equal(canonicalizeMediaUrl('https://www.instagram.com/tv/AbCdE12345/').provider, 'instagram');
});

test('Media sizes and formats are bounded at the fetch result boundary', async () => {
  await assert.rejects(fetchMedia({ ...input, maxBytes: 2 }, { requestBody: async () => ({ body: photo }) }), /MEDIA_TOO_LARGE/);
  await assert.rejects(fetchMedia(input, { requestBody: async () => ({ body: Buffer.from('<html>error</html>') }) }), /MEDIA_FORMAT_UNSUPPORTED/);
});

test('Engine processes receive the gated SOCKS route and a sanitized environment', async context => {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'PYTHONPATH'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  context.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of keys) process.env[key] = 'synthetic-untrusted-setting';
  const result = await runEngine({ enginePath: 'synthetic-engine', nodePath: process.execPath, tempDir: path.dirname(process.execPath), proxy: 'socks5h://127.0.0.1:23333' }, 'download', 'https://x.com/i/status/1234567890123456789', new globalThis.AbortController().signal, {
    spawn: (executable, arguments_, options) => {
      assert.equal(executable, 'synthetic-engine');
      assert.equal(arguments_[arguments_.indexOf('--proxy') + 1], 'socks5h://127.0.0.1:23333');
      for (const key of keys) assert.equal(options.env[key], undefined);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.kill = () => {};
      child.stdin.end = () => globalThis.queueMicrotask(() => { child.stdout.emit('data', Buffer.from('synthetic metadata')); child.emit('close', 0); });
      return child;
    },
  });
  assert.equal(result.toString(), 'synthetic metadata');
});

test('Direct engine metadata and downloads disable ambient proxies explicitly', async context => {
  const keys = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  context.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of keys) process.env[key] = 'http://127.0.0.1:23333';
  for (const phase of ['metadata', 'download']) {
    await runEngine({ enginePath: 'synthetic-engine', nodePath: process.execPath, tempDir: path.dirname(process.execPath), proxyPort: 23333 }, phase, 'https://www.youtube.com/watch?v=abcdefghijk', new globalThis.AbortController().signal, {
      spawn: (executable, arguments_, options) => {
        assert.equal(arguments_[arguments_.indexOf('--proxy') + 1], '');
        for (const key of keys) assert.equal(options.env[key], undefined);
        assert.equal(options.env.EGOIST_RELAY_MEDIA_PROXY, undefined);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => {};
        child.stdin.end = () => globalThis.queueMicrotask(() => child.emit('close', 0));
        return child;
      },
    });
  }
});

test('Engine argument creation rejects an invalid selected proxy', () => {
  assert.throws(() => createEngineArgs({ nodePath: process.execPath, tempDir: path.dirname(process.execPath), proxy: 'http://bad/proxy' }, 'metadata'), /MEDIA_PROXY_DENIED/);
});

for (const [diagnostic, expected] of [
  ['ERROR: [youtube] abcdefghijk: Sign in to confirm you’re not a bot. This helps protect our community.', 'MEDIA_BOT_CHECK'],
  ['ERROR: This video is not available in your country', 'MEDIA_GEO_BLOCKED'],
  ['ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', 'MEDIA_RATE_LIMITED'],
  ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'MEDIA_HTTP_FORBIDDEN'],
  ['ERROR: Unable to connect to proxy: connection refused', 'MEDIA_PROXY_FAILED'],
  ['ERROR: Connection reset by peer', 'MEDIA_FETCH_FAILED'],
  ['ERROR: Sign in to confirm your age', 'MEDIA_AUTH_REQUIRED'],
]) {
  test(`Engine rejection reports ${expected} without confusing a bot check with login`, async () => {
    await assert.rejects(runEngine({ enginePath: 'synthetic-engine', nodePath: process.execPath, tempDir: path.dirname(process.execPath) }, 'download', 'https://www.youtube.com/watch?v=abcdefghijk', new globalThis.AbortController().signal, {
      spawn: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
        child.kill = () => {};
        child.stdin.end = () => globalThis.queueMicrotask(() => { child.stderr.emit('data', Buffer.from(diagnostic)); child.emit('close', 1); });
        return child;
      },
    }), { message: expected });
  });
}

test('Synthetic session cookies reject injection and cross-provider domains', () => {
  const cookie = { domain: '.instagram.com', path: '/', secure: true, expires: 0, name: 'sessionid', value: 'synthetic-only' };
  assert.match(serializeCookies([cookie], 'instagram'), /sessionid\tsynthetic-only/);
  assert.throws(() => serializeCookies([{ ...cookie, value: 'invalid\nline' }], 'instagram'), /MEDIA_SESSION_LIMIT/);
  assert.throws(() => serializeCookies([cookie], 'x'), /MEDIA_SESSION_LIMIT/);
});

async function createAuditDirectory(context) {
  const directory = await fs.mkdtemp(path.join(process.env.EGOIST_RELAY_AUDIT_WORK, 'media-fixture-'));
  context.after(async () => {
    const root = path.resolve(process.env.EGOIST_RELAY_AUDIT_WORK);
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), root);
    await fs.rm(target, { recursive: true, force: true });
  });
  return directory;
}

test('Successful public media resolution clears temporary files and synthetic cookies', { skip: !process.env.EGOIST_RELAY_AUDIT_WORK }, async context => {
  const tempDir = await createAuditDirectory(context);
  const bytes = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  const result = await resolveMedia({ url: 'https://www.instagram.com/reel/AbCdE12345/', enginePath: path.join(tempDir, 'synthetic-engine.exe'), nodePath: process.execPath, ffmpegPath: path.join(tempDir, 'synthetic-ffmpeg.exe'), tempDir, index: 0, maxBytes: 32, cookies: [{ domain: '.instagram.com', path: '/', secure: true, expires: 0, name: 'sessionid', value: 'synthetic-only' }] }, {
    runEngine: async (engineInput, phase) => {
      assert.equal(engineInput.proxy, '');
      const arguments_ = createEngineArgs(engineInput, phase); assert.equal(arguments_[arguments_.indexOf('--proxy') + 1], '');
      assert.match(await fs.readFile(path.join(tempDir, 'session-cookies.txt'), 'utf8'), /synthetic-only/);
      await fs.writeFile(path.join(tempDir, 'media.mp4'), bytes);
      return Buffer.from(JSON.stringify({ extractor_key: 'Instagram', duration: 5 }));
    },
    inspectLocalVideo: async (input_, filename, signal, duration) => { assert.equal(duration, 5); assert.equal(signal.aborted, false); },
  });
  assert.equal(result.metadata.size, bytes.length);
  assert.equal(result.metadata.mimeType, 'video/mp4');
  assert.deepEqual(await fs.readdir(tempDir), []);
});

test('Failed public media resolution also clears partial output', { skip: !process.env.EGOIST_RELAY_AUDIT_WORK }, async context => {
  const tempDir = await createAuditDirectory(context);
  await assert.rejects(resolveMedia({ url: 'https://x.com/i/status/1234567890123456789', enginePath: path.join(tempDir, 'synthetic-engine.exe'), nodePath: process.execPath, tempDir, index: 0 }, {
    runEngine: async () => { await fs.writeFile(path.join(tempDir, 'media.mp4.part'), 'partial'); throw new Error('MEDIA_FETCH_FAILED'); },
  }), /MEDIA_FETCH_FAILED/);
  assert.deepEqual(await fs.readdir(tempDir), []);
});

test('A malformed resolver route fails before engine execution and temporary writes', { skip: !process.env.EGOIST_RELAY_AUDIT_WORK }, async context => {
  const tempDir = await createAuditDirectory(context);
  const previous = process.env.EGOIST_RELAY_MEDIA_PROXY;
  context.after(() => { process.env.EGOIST_RELAY_MEDIA_PROXY = previous; });
  process.env.EGOIST_RELAY_MEDIA_PROXY = 'http://bad/proxy';
  let executions = 0;
  await assert.rejects(resolveMedia({ url: 'https://x.com/i/status/1234567890123456789', enginePath: path.join(tempDir, 'synthetic-engine.exe'), nodePath: process.execPath, tempDir, index: 0 }, {
    runEngine: async () => { executions++; return Buffer.alloc(0); },
  }), /MEDIA_PROXY_DENIED/);
  assert.equal(executions, 0); assert.deepEqual(await fs.readdir(tempDir), []);
});

test('An empty download reports unavailable format without repeating metadata extraction', { skip: !process.env.EGOIST_RELAY_AUDIT_WORK }, async context => {
  const tempDir = await createAuditDirectory(context);
  const phases = [];
  await assert.rejects(resolveMedia({
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    enginePath: path.join(tempDir, 'synthetic-engine.exe'), nodePath: process.execPath,
    tempDir, index: 0,
  }, {
    runEngine: async (input_, phase) => {
      assert.equal(input_.proxy, '');
      const arguments_ = createEngineArgs(input_, phase); assert.equal(arguments_[arguments_.indexOf('--proxy') + 1], '');
      phases.push(phase);
      return phase === 'download' ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify({ extractor_key: 'Youtube', duration: 1344 }));
    },
  }), { message: 'MEDIA_FORMAT_UNAVAILABLE' });
  assert.deepEqual(phases, ['download']);
  assert.deepEqual(await fs.readdir(tempDir), []);
});

test('File-backed Node workers load the exact proxy module and reject invalid IPC input', { timeout: 5000, skip: !process.env.EGOIST_RELAY_AUDIT_WORK }, async context => {
  const directory = await createAuditDirectory(context);
  const helper = await fs.readFile(new URL('./media-proxy.mjs', import.meta.url), 'utf8');
  await fs.writeFile(path.join(directory, 'media-proxy.mjs'), helper, { flag: 'wx' });
  const worker = path.join(directory, 'worker.mjs');
  for (const filename of ['social-media-fetch.mjs', 'inline-media-resolver.mjs']) {
    const source = await fs.readFile(new URL(filename, import.meta.url), 'utf8');
    await fs.writeFile(worker, source);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker], { cwd: directory, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      let error = '';
      child.once('error', reject);
      child.stderr.on('data', chunk => { error += chunk; });
      child.once('close', code => {
        try { assert.equal(code, 1); assert.equal(error, 'MEDIA_INPUT_DENIED'); resolve(); } catch (failure) { reject(failure); }
      });
      child.stdin.end('{}');
    });
  }
});

test('Fragment renames during a size-guard scan do not cancel valid media', { timeout: 5000, skip: !process.env.EGOIST_RELAY_AUDIT_WORK }, async context => {
  const tempDir = await createAuditDirectory(context);
  const originalLstat = fs.lstat;
  let hasObservedRemoval = false;
  context.after(() => { fs.lstat = originalLstat; });
  fs.lstat = async filename => {
    if (!hasObservedRemoval && filename === path.join(tempDir, 'media.mp4.part')) {
      hasObservedRemoval = true;
      await fs.unlink(filename);
      throw Object.assign(new Error('Synthetic fragment rename'), { code: 'ENOENT' });
    }
    return originalLstat(filename);
  };
  const bytes = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  const result = await resolveMedia({ url: 'https://x.com/i/status/1234567890123456789', enginePath: path.join(tempDir, 'synthetic-engine.exe'), nodePath: process.execPath, ffmpegPath: path.join(tempDir, 'synthetic-ffmpeg.exe'), tempDir, index: 0 }, {
    runEngine: async (input_, phase, url, signal) => {
      await fs.writeFile(path.join(tempDir, 'media.mp4.part'), 'partial');
      await new Promise(resolve => setTimeout(resolve, 250));
      if (signal.aborted) throw new Error('MEDIA_CANCELLED');
      await fs.writeFile(path.join(tempDir, 'media.mp4'), bytes);
      return Buffer.from(JSON.stringify({ extractor_key: 'Twitter', duration: 5 }));
    },
    inspectLocalVideo: async () => {},
  });
  assert.equal(hasObservedRemoval, true);
  assert.equal(result.metadata.size, bytes.length);
});


test('File output applies the same explicit byte budget to the engine', () => {
  const args = createEngineArgs({ nodePath: process.execPath, tempDir: path.dirname(process.execPath), outputMode: 'file', maxBytes: 1024 }, 'download');
  assert.equal(args[args.indexOf('--max-filesize') + 1], '1024');
});
