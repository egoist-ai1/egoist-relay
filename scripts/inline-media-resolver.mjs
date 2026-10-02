import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { connectMediaProxy, createSocketReader, parseMediaProxy } from './media-proxy.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_METADATA = 2 * 1024 * 1024;
const TIMEOUT_MS = 120000;
const FILE_TIMEOUT_MS = 900000;
const DISK_RESERVE_BYTES = 64 * 1024 * 1024;
const EXPECTED_KEYS = new Set(['url', 'enginePath', 'nodePath', 'ffmpegPath', 'tempDir', 'proxyPort', 'index', 'maxBytes', 'cookies', 'outputMode']);
const MEDIA_HOSTS = { youtube: ['youtube.com', 'youtubei.googleapis.com', 'googlevideo.com', 'ytimg.com'], instagram: ['instagram.com', 'cdninstagram.com', 'fbcdn.net'], x: ['x.com', 'twitter.com', 'twimg.com'] };

export async function createSocksGate(proxy, provider, signal) {
  if (!proxy) throw new Error('MEDIA_PROXY_DENIED');
  const sockets = new Set(); let connections = 0;
  const server = net.createServer(client => {
    if (sockets.size >= 64 || ++connections > 4096 || signal.aborted) { client.destroy(); return; }
    sockets.add(client); client.once('close', () => sockets.delete(client)); client.on('error', () => {});
    client.setTimeout(30000, () => client.destroy());
    const connection = new globalThis.AbortController();
    client.once('close', () => connection.abort());
    const connectionSignal = globalThis.AbortSignal.any([signal, connection.signal]);
    void (async () => {
      const incoming = createSocketReader(client);
      const greeting = await incoming.read(2);
      if (greeting[0] !== 5 || !greeting[1] || greeting[1] > 16 || !(await incoming.read(greeting[1])).includes(0)) throw new Error('MEDIA_PROXY_DENIED');
      client.write(Buffer.from([5, 0]));
      const request = await incoming.read(4);
      if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0 || request[3] !== 3) throw new Error('MEDIA_PROXY_DENIED');
      const length = (await incoming.read(1))[0];
      if (!length || length > 253) throw new Error('MEDIA_PROXY_DENIED');
      const hostname = (await incoming.read(length)).toString('utf8').toLowerCase();
      const port = (await incoming.read(2)).readUInt16BE();
      if (port !== 443 || !/^[a-z0-9.-]+$/.test(hostname) || net.isIP(hostname) || !MEDIA_HOSTS[provider]?.some(host => hostname === host || hostname.endsWith(`.${host}`))) throw new Error('MEDIA_PROXY_DENIED');
      const upstream = await connectMediaProxy(hostname, proxy, connectionSignal);
      if (client.destroyed || connectionSignal.aborted) { upstream.destroy(); throw new Error('MEDIA_CANCELLED'); }
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream)); upstream.on('error', () => {}); upstream.setTimeout(30000, () => upstream.destroy());
      client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      incoming.release(); client.pipe(upstream); upstream.pipe(client);
    })().catch(() => { if (!client.destroyed) client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); });
  });
  const close = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  signal.addEventListener('abort', close, { once: true });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (signal.aborted) throw new Error('MEDIA_CANCELLED');
  } catch (error) { signal.removeEventListener('abort', close); close(); throw error; }
  return { port: server.address().port, close: () => { signal.removeEventListener('abort', close); close(); } };
}

export function canonicalizeMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || [...value].some(character => character.charCodeAt(0) <= 32 || character === '\\' || character === '%')
    || /\/(?:\.{1,2})(?:\/|[?#]|$)/.test(value)) throw new Error('MEDIA_URL_DENIED');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('MEDIA_URL_DENIED');
  const host = url.hostname.toLowerCase();
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
    let id;
    if (host === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    else if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
    else id = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('MEDIA_URL_DENIED');
    return { provider: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (['instagram.com', 'www.instagram.com'].includes(host)) {
    const match = /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})\/?$/.exec(url.pathname);
    if (!match) throw new Error('MEDIA_URL_DENIED');
    return { provider: 'instagram', url: `https://www.instagram.com/${match[1] === 'reels' ? 'reel' : match[1]}/${match[2]}/` };
  }
  if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host)) {
    const match = /^\/[A-Za-z0-9_]{1,30}\/status\/([0-9]{5,24})\/?$/.exec(url.pathname);
    if (!match) throw new Error('MEDIA_URL_DENIED');
    return { provider: 'x', url: `https://x.com/i/status/${match[1]}` };
  }
  throw new Error('MEDIA_URL_DENIED');
}

export function createEngineArgs(input, phase) {
  const selected = input.proxy === '' ? 'direct' : input.proxy ?? process.env.EGOIST_RELAY_MEDIA_PROXY;
  const configured = parseMediaProxy(selected);
  const proxy = configured ? selected : '';
  const common = ['--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-cache-dir', '--no-update', '--no-playlist', '--playlist-items', '1', '--use-extractors', 'Youtube,Instagram,Twitter,end', '--no-remote-components', '--no-js-runtimes', '--js-runtimes', `node:${input.nodePath}`, '--proxy', proxy, '--socket-timeout', '15', '--retries', '1', '--fragment-retries', '1', '--concurrent-fragments', '4', '--extractor-retries', '1', '--no-warnings', '--no-progress', '--quiet', '--xff', 'never', '--no-check-formats', '--batch-file', '-'];
  if (input.cookies) common.push('--cookies', path.join(input.tempDir, 'session-cookies.txt'));
  const sourceMetadata = '%(.{extractor_key,duration,is_live,live_status})j';
  if (phase === 'metadata') return [...common, '--skip-download', '--print', sourceMetadata];
  const maximum = input.outputMode === 'file' ? [] : ['--max-filesize', String(input.maxBytes || MAX_BYTES)];
  const selectedFormat = input.ffmpegPath ? 'bestvideo*+bestaudio/best/bestvideo' : 'best/bestvideo';
  return [...common, '--no-simulate', ...maximum, '--abort-on-unavailable-fragments', '--match-filters', '!is_live', '--print', `before_dl:${sourceMetadata}`, '--format', selectedFormat, '--ffmpeg-location', input.ffmpegPath || input.tempDir, '--postprocessor-args', 'ffmpeg_i:-protocol_whitelist file,pipe', '--fixup', input.ffmpegPath ? 'detect_or_warn' : 'never', '--merge-output-format', 'mp4/webm', '--no-write-info-json', '--no-write-thumbnail', '--no-write-subs', '--no-write-auto-subs', '--no-mtime', '--restrict-filenames', '--output', path.join(input.tempDir, 'media.%(ext)s')];
}

export function classifyEngineError(stderr) {
  if (/confirm.{0,80}bot|captcha|unusual traffic/i.test(stderr)) return 'MEDIA_BOT_CHECK';
  if (/not available in your (?:country|region)|blocked in your (?:country|region)|geo.?restrict|not available from your location/i.test(stderr)) return 'MEDIA_GEO_BLOCKED';
  if (/HTTP(?:\s+Error)?[\s:]+429\b|too many requests|rate.?limit/i.test(stderr)) return 'MEDIA_RATE_LIMITED';
  if (/sign.?in|log.?in|required.*cookie|confirm.*bot|private.*video|age.?restrict/i.test(stderr)) return 'MEDIA_AUTH_REQUIRED';
  if (/certificate|ssl|tls/i.test(stderr)) return 'MEDIA_TLS_FAILED';
  if (/larger than|maximum filesize|too large/i.test(stderr)) return 'MEDIA_TOO_LARGE';
  if (/requested format|no video formats|only images|ffmpeg/i.test(stderr)) return 'MEDIA_FORMAT_UNAVAILABLE';
  if (/timed? ?out/i.test(stderr)) return 'MEDIA_TIMEOUT';
  if (/proxy(?:error| connection| refused| failed)|socks.*(?:failed|error|refused)|unable to connect.*proxy/i.test(stderr)) return 'MEDIA_PROXY_FAILED';
  if (/HTTP(?:\s+Error)?[\s:]+403\b|403\s+Forbidden/i.test(stderr)) return 'MEDIA_HTTP_FORBIDDEN';
  if (/connection (?:refused|reset|aborted)|network is unreachable|HTTP(?:\s+Error)?[\s:]+5[0-9]{2}\b|unable to resolve|name or service not known/i.test(stderr)) return 'MEDIA_FETCH_FAILED';
  return 'MEDIA_UNAVAILABLE';
}

function createEngineEnvironment(tempDir) {
  const environment = { ...process.env, TEMP: tempDir, TMP: tempDir };
  for (const key of Object.keys(environment)) if (/proxy|yt.?dlp|sslkeylog|pythonpath|pythonhome|pythonhttpsverify|ssl_cert_file|ssl_cert_dir|node_options|node_extra_ca_certs|node_tls_reject_unauthorized|curl_ca_bundle|requests_ca_bundle/i.test(key)) delete environment[key];
  return environment;
}

export async function runEngine(input, phase, canonicalUrl, signal, overrides = {}) {
  const spawnEngine = overrides.spawn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnEngine(input.enginePath, createEngineArgs(input, phase), { cwd: input.tempDir, env: createEngineEnvironment(input.tempDir), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = Buffer.alloc(0); let stderr = ''; let failure;
    function fail(code) { if (failure) return; failure = new Error(code); child.kill(); }
    const abort = () => fail('MEDIA_CANCELLED');
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => { signal.removeEventListener('abort', abort); reject(new Error('MEDIA_RUNTIME_UNAVAILABLE')); });
    child.stdout.on('data', chunk => { if (stdout.length + chunk.length > MAX_METADATA) { fail('MEDIA_METADATA_TOO_LARGE'); return; } stdout = Buffer.concat([stdout, chunk]); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-16384); });
    child.stdin.on('error', () => fail('MEDIA_FETCH_FAILED'));
    child.once('close', code => { signal.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0) reject(new Error(classifyEngineError(stderr))); else resolve(stdout); });
    child.stdin.end(canonicalUrl + '\n');
    if (signal.aborted) abort();
  });
}

export function validateMetadata(value, provider) {
  if (!value || typeof value !== 'object') throw new Error('MEDIA_METADATA_INVALID');
  let video = value;
  if (Array.isArray(value.entries)) {
    if (value.entries.length !== 1 || !value.entries[0]) throw new Error('MEDIA_MULTIPLE_ITEMS');
    [video] = value.entries;
  }
  const extractor = String(video.extractor_key || video.extractor || '');
  const expected = provider === 'youtube' ? /^youtube$/i : provider === 'instagram' ? /^instagram$/i : /^twitter$/i;
  if (!expected.test(extractor) || video.is_live || ['is_live', 'is_upcoming', 'post_live'].includes(video.live_status)) throw new Error('MEDIA_SOURCE_DENIED');
  if (video.duration === undefined && provider !== 'instagram') throw new Error('MEDIA_DURATION_UNKNOWN');
  if (video.duration !== undefined && (typeof video.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0)) throw new Error('MEDIA_DURATION_UNKNOWN');
  if (video.formats !== undefined && (!Array.isArray(video.formats) || !video.formats.some(format => ['mp4', 'webm'].includes(format.ext) && format.vcodec !== 'none'))) throw new Error('MEDIA_FORMAT_UNAVAILABLE');
  return video;
}

function identifyVideo(bytes) {
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /^(isom|iso[2-6]|mp4[12]|avc1|dash|M4V )$/.test(bytes.subarray(8, 12).toString('ascii'))) return { mimeType: 'video/mp4', extension: 'mp4' };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mimeType: 'video/webm', extension: 'webm' };
  throw new Error('MEDIA_FORMAT_UNAVAILABLE');
}

async function inspectLocalVideo(input, filename, signal, expectedDuration) {
  if (!input.ffmpegPath) throw new Error('MEDIA_RUNTIME_UNAVAILABLE');
  const executable = path.join(path.dirname(input.ffmpegPath), 'ffprobe.exe');
  const bytes = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration,size:stream=codec_type,codec_name', '-of', 'json', '-i', filename], { windowsHide: true, cwd: input.tempDir, env: createEngineEnvironment(input.tempDir), stdio: ['ignore', 'pipe', 'ignore'] });
    let output = Buffer.alloc(0); let failure;
    const abort = () => { failure = new Error('MEDIA_CANCELLED'); child.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => { signal.removeEventListener('abort', abort); reject(new Error('MEDIA_RUNTIME_UNAVAILABLE')); });
    child.stdout.on('data', chunk => { if (output.length + chunk.length > 8192) { failure = new Error('MEDIA_FORMAT_UNAVAILABLE'); child.kill(); } else output = Buffer.concat([output, chunk]); });
    child.once('close', code => { signal.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0) reject(new Error('MEDIA_FORMAT_UNAVAILABLE')); else resolve(output); });
    if (signal.aborted) abort();
  });
  const metadata = JSON.parse(bytes.toString('utf8'));
  const duration = Number(metadata.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('MEDIA_FORMAT_UNAVAILABLE');
  if (expectedDuration !== undefined && Math.abs(duration - expectedDuration) > Math.max(2, expectedDuration * 0.02)) throw new Error('MEDIA_PARTIAL_BODY');
  if (!Array.isArray(metadata.streams) || !metadata.streams.some(stream => stream.codec_type === 'video')) throw new Error('MEDIA_FORMAT_UNAVAILABLE');
}

export async function resolveMedia(input, overrides = {}) {
  if (!input || Object.keys(input).some(key => !EXPECTED_KEYS.has(key)) || (input.proxyPort !== undefined && (!Number.isInteger(input.proxyPort) || input.proxyPort < 1 || input.proxyPort > 65535))
    || (input.outputMode !== undefined && input.outputMode !== 'file')
    || !Number.isInteger(input.index) || input.index < 0 || input.index >= 10
    || (input.maxBytes !== undefined && (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_BYTES))) throw new Error('MEDIA_INPUT_DENIED');
  for (const key of ['enginePath', 'nodePath', 'tempDir']) if (typeof input[key] !== 'string' || !path.isAbsolute(input[key])) throw new Error('MEDIA_INPUT_DENIED');
  if (input.ffmpegPath !== undefined && (typeof input.ffmpegPath !== 'string' || !path.isAbsolute(input.ffmpegPath))) throw new Error('MEDIA_INPUT_DENIED');
  const canonical = canonicalizeMediaUrl(input.url);
  const proxy = parseMediaProxy(process.env.EGOIST_RELAY_MEDIA_PROXY);
  const cookieContent = input.cookies === undefined ? undefined : serializeCookies(input.cookies, canonical.provider);
  const realTemp = await fs.realpath(input.tempDir);
  const expectedTemp = path.resolve(input.tempDir).replace(/^\\\\\?\\/, '');
  if (realTemp.replace(/^\\\\\?\\/, '').toLowerCase() !== expectedTemp.toLowerCase() || (await fs.lstat(realTemp)).isSymbolicLink()) throw new Error('MEDIA_PATH_DENIED');
  const isFileOutput = input.outputMode === 'file';
  const disk = isFileOutput ? await fs.statfs(realTemp) : undefined;
  const maximum = isFileOutput ? Math.floor((Number(disk.bavail) * Number(disk.bsize) - DISK_RESERVE_BYTES) / 2) : input.maxBytes || MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('MEDIA_DISK_FULL');
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), isFileOutput ? FILE_TIMEOUT_MS : TIMEOUT_MS);
  const execute = overrides.runEngine || runEngine;
  let isSizeExceeded = false;
  let gate;
  let retainedFile;
  const guard = setInterval(async () => {
    try {
      const names = await fs.readdir(realTemp);
      let total = 0;
      for (const name of names) {
        if (!/^media(?:\.|$)/.test(name)) continue;
        let stat;
        try { stat = await fs.lstat(path.join(realTemp, name)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.isSymbolicLink() || !stat.isFile()) { isSizeExceeded = true; controller.abort(); break; }
        total += stat.size;
        if (stat.size > maximum || total > maximum * 2) { isSizeExceeded = true; controller.abort(); break; }
      }
    } catch { controller.abort(); }
  }, 100);
  try {
    if (cookieContent !== undefined) await fs.writeFile(path.join(realTemp, 'session-cookies.txt'), cookieContent, { flag: 'wx', mode: 0o600 });
    if (proxy) gate = await createSocksGate(proxy, canonical.provider, controller.signal);
    const engineInput = { ...input, proxy: gate ? `socks5h://127.0.0.1:${gate.port}` : '' };
    const sourceInfo = await execute(engineInput, 'download', canonical.url, controller.signal);
    if (!sourceInfo.toString('utf8').trim()) throw new Error('MEDIA_FORMAT_UNAVAILABLE');
    let metadata; try { metadata = JSON.parse(sourceInfo.toString('utf8')); } catch { throw new Error('MEDIA_FORMAT_UNAVAILABLE'); }
    const source = validateMetadata(metadata, canonical.provider);
    const files = (await fs.readdir(realTemp)).filter(name => /^media\.(mp4|webm)$/.test(name));
    if (files.length !== 1) throw new Error('MEDIA_FORMAT_UNAVAILABLE');
    const filename = path.join(realTemp, files[0]);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('MEDIA_PATH_DENIED');
    if (stat.size <= 12) throw new Error('MEDIA_TOO_LARGE');
    if (stat.size > maximum) throw new Error(isFileOutput ? 'MEDIA_DISK_FULL' : 'MEDIA_TOO_LARGE');
    if (isFileOutput) {
      const file = await fs.open(filename, 'r');
      const prefix = Buffer.alloc(16);
      try { await file.read(prefix, 0, prefix.length, 0); } finally { await file.close(); }
      const format = identifyVideo(prefix);
      await (overrides.inspectLocalVideo || inspectLocalVideo)(input, filename, controller.signal, source.duration);
      retainedFile = filename;
      return { filePath: filename, metadata: { index: input.index, name: `relay-${canonical.provider}-${input.index + 1}.${format.extension}`, mimeType: format.mimeType, size: stat.size } };
    }
    const body = await fs.readFile(filename);
    if (body.length !== stat.size) throw new Error('MEDIA_PARTIAL_BODY');
    const format = identifyVideo(body);
    await (overrides.inspectLocalVideo || inspectLocalVideo)(input, filename, controller.signal, source.duration);
    return { body, metadata: { index: input.index, name: `relay-${canonical.provider}-${input.index + 1}.${format.extension}`, mimeType: format.mimeType, size: body.length } };
  } catch (error) {
    if (isSizeExceeded) throw new Error(isFileOutput ? 'MEDIA_DISK_FULL' : 'MEDIA_TOO_LARGE', { cause: error });
    if (controller.signal.aborted) throw new Error('MEDIA_TIMEOUT', { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout); clearInterval(guard);
    gate?.close();
    await fs.unlink(path.join(realTemp, 'session-cookies.txt')).catch(error => { if (error.code !== 'ENOENT') throw new Error('MEDIA_CLEANUP_FAILED'); });
    for (const name of await fs.readdir(realTemp)) {
      if (!/^media(?:\.|$)/.test(name)) continue;
      const target = path.join(realTemp, name);
      if (target === retainedFile) continue;
      if ((await fs.lstat(target)).isFile()) await fs.unlink(target);
    }
  }
}

export function serializeCookies(cookies, provider) {
  const domain = provider === 'instagram' ? 'instagram.com' : provider === 'x' ? 'x.com' : undefined;
  if (!domain || !Array.isArray(cookies) || !cookies.length || cookies.length > 32 || Buffer.byteLength(JSON.stringify(cookies)) > 65536) throw new Error('MEDIA_SESSION_LIMIT');
  const lines = cookies.map(cookie => {
    if (!cookie || Object.keys(cookie).some(key => !['domain', 'path', 'secure', 'expires', 'name', 'value'].includes(key))
      || typeof cookie.domain !== 'string' || cookie.domain.replace(/^\./, '') !== domain
      || typeof cookie.name !== 'string' || !cookie.name || cookie.name.length > 128
      || typeof cookie.value !== 'string' || cookie.value.length > 8192
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 1024
      || typeof cookie.secure !== 'boolean' || !Number.isSafeInteger(cookie.expires) || cookie.expires < 0
      || [cookie.domain, cookie.path, cookie.name, cookie.value].some(value => [...value].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127))) throw new Error('MEDIA_SESSION_LIMIT');
    return [cookie.domain, cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE', cookie.path, cookie.secure ? 'TRUE' : 'FALSE', cookie.expires, cookie.name, cookie.value].join('\t');
  });
  return '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n';
}

async function run() {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 81920) throw new Error('MEDIA_INPUT_DENIED'); }
  const result = await resolveMedia(JSON.parse(input));
  if (result.filePath) { process.stdout.end(JSON.stringify(result)); return; }
  const metadata = Buffer.from(JSON.stringify(result.metadata));
  const header = Buffer.alloc(8); header.write('ERMS'); header.writeUInt32LE(metadata.length, 4);
  await new Promise((resolve, reject) => { process.stdout.once('error', reject); process.stdout.end(Buffer.concat([header, metadata, result.body]), resolve); });
}

if ((process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) || !process.argv[1]) {
  const watchdog = setTimeout(() => process.exit(1), FILE_TIMEOUT_MS + 1000);
  run().catch(error => { process.stderr.write(/^MEDIA_[A-Z_]+$/.test(error.message) ? error.message : 'MEDIA_FETCH_FAILED'); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
}
