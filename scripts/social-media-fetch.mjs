import tls from 'node:tls';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import http2 from 'node:http2';
import { pathToFileURL } from 'node:url';
import { connectMediaProxy, parseMediaProxy } from './media-proxy.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 60000;
const FILE_TIMEOUT_MS = 900000;
const DISK_RESERVE_BYTES = 64 * 1024 * 1024;
const USER_AGENT = 'EgoistRelay';
const HOSTS = { x: ['pbs.twimg.com', 'video.twimg.com'], instagram: ['cdninstagram.com', 'fbcdn.net'] };

export function validateMediaUrl(value, service) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\p{Control}]/u.test(value) || !HOSTS[service]) throw new Error('MEDIA_URL_DENIED');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('MEDIA_URL_DENIED');
  const host = url.hostname.toLowerCase();
  const allowed = HOSTS[service].some(allowedHost => host === allowedHost || (service === 'instagram' && host.endsWith(`.${allowedHost}`)));
  if (!allowed || /\.(?:m3u8|mpd)(?:$|\/)/i.test(url.pathname)) throw new Error('MEDIA_URL_DENIED');
  return url;
}

export function identifyMedia(bytes, requestedType) {
  const is = signature => bytes.subarray(0, signature.length).equals(Buffer.from(signature));
  if (requestedType === 'photo') {
    if (is([0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', extension: 'jpg' };
    if (is([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mimeType: 'image/png', extension: 'png' };
    if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return { mimeType: 'image/gif', extension: 'gif' };
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
  }
  if (requestedType === 'video') {
    if (bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /^(isom|iso[2-6]|mp4[12]|avc1|dash|M4V )$/.test(bytes.subarray(8, 12).toString('ascii'))) return { mimeType: 'video/mp4', extension: 'mp4' };
    if (is([0x1a, 0x45, 0xdf, 0xa3])) return { mimeType: 'video/webm', extension: 'webm' };
  }
  throw new Error('MEDIA_FORMAT_UNSUPPORTED');
}

export async function fetchMedia(input, overrides = {}) {
  if (!input || (input.proxyPort !== undefined && (!Number.isInteger(input.proxyPort) || input.proxyPort < 1 || input.proxyPort > 65535))
    || (input.maxBytes !== undefined && (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_BYTES))
    || (input.outputMode !== undefined && input.outputMode !== 'file')
    || !['photo', 'video'].includes(input.type) || !Number.isInteger(input.index) || input.index < 0 || input.index >= 10) throw new Error('MEDIA_INPUT_DENIED');
  let url = validateMediaUrl(input.url, input.service);
  const proxy = parseMediaProxy(process.env.EGOIST_RELAY_MEDIA_PROXY);
  const isFileOutput = input.outputMode === 'file';
  let destination; let maximum = Math.min(MAX_BYTES, input.maxBytes || MAX_BYTES);
  if (isFileOutput) {
    if (typeof input.tempDir !== 'string' || !path.isAbsolute(input.tempDir)) throw new Error('MEDIA_PATH_DENIED');
    const directory = await fs.realpath(input.tempDir);
    if (directory.replace(/^\\\\\?\\/, '').toLowerCase() !== path.resolve(input.tempDir).replace(/^\\\\\?\\/, '').toLowerCase()
      || (await fs.lstat(directory)).isSymbolicLink()) throw new Error('MEDIA_PATH_DENIED');
    const disk = await fs.statfs(directory);
    maximum = Math.floor((Number(disk.bavail) * Number(disk.bsize) - DISK_RESERVE_BYTES) / 2);
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('MEDIA_DISK_FULL');
    destination = path.join(directory, 'media.download');
  }
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), isFileOutput ? FILE_TIMEOUT_MS : TIMEOUT_MS);
  const requestBody = overrides.requestBody || ((url_, proxy_, maximum_, signal_) => getBody(url_, proxy_, maximum_, signal_, overrides, destination));
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const result = await requestBody(url, proxy, maximum, controller.signal);
      if (result.redirect) { url = validateMediaUrl(new URL(result.redirect, url).href, input.service); continue; }
      if (isFileOutput) {
        if (result.filePath !== destination || !Number.isSafeInteger(result.size) || result.size <= 0) throw new Error('MEDIA_PARTIAL_BODY');
        const format = identifyMedia(result.prefix, input.type);
        return { filePath: destination, metadata: { index: input.index, name: `relay-${input.service}-${input.index + 1}.${format.extension}`, mimeType: format.mimeType, size: result.size } };
      }
      if (!Buffer.isBuffer(result.body) || !result.body.length) throw new Error('MEDIA_PARTIAL_BODY');
      if (result.body.length > maximum) throw new Error('MEDIA_TOO_LARGE');
      const format = identifyMedia(result.body, input.type);
      return { body: result.body, metadata: { index: input.index, name: `relay-${input.service}-${input.index + 1}.${format.extension}`, mimeType: format.mimeType, size: result.body.length } };
    }
    throw new Error('MEDIA_REDIRECT_LIMIT');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('MEDIA_TIMEOUT', { cause: error });
    throw error;
  } finally { clearTimeout(timer); }
}

async function getBody(url, proxy, maximum, signal, overrides, destination) {
  const tunnel = await connectMediaProxy(url.hostname, proxy, signal, overrides);
  const secure = (overrides.connectTls || tls.connect)({ socket: tunnel, servername: url.hostname, ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: true });
  const abort = () => secure.destroy(new Error('MEDIA_TIMEOUT'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', () => reject(new Error('MEDIA_TLS_FAILED'))); });
    if (secure.alpnProtocol === 'h2') {
      const client = http2.connect(url.origin, { createConnection: () => secure });
      try {
        return await new Promise((resolve, reject) => {
          client.once('error', () => reject(new Error('MEDIA_CONNECTION_FAILED')));
          const stream = client.request({ ':method': 'GET', ':path': url.pathname + url.search, accept: 'image/*,video/*', 'accept-encoding': 'identity', 'user-agent': USER_AGENT });
          stream.once('error', () => reject(new Error('MEDIA_PARTIAL_BODY')));
          stream.once('response', headers => collectBody(stream, Number(headers[':status']), headers, maximum, resolve, reject, () => stream.rstCode === 0, destination));
          stream.end();
        });
      } finally { client.destroy(); }
    }
    const agent = new https.Agent({ keepAlive: true });
    agent.createConnection = () => secure;
    try { return await new Promise((resolve, reject) => {
      const request = https.request(url, { method: 'GET', agent, headers: { Accept: 'image/*,video/*', 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT } });
      request.once('error', () => reject(new Error('MEDIA_CONNECTION_FAILED')));
      request.once('response', response => collectBody(response, response.statusCode, response.headers, maximum, resolve, reject, () => response.complete, destination));
      request.end();
    }); } finally { agent.destroy(); }
  } finally { signal.removeEventListener('abort', abort); secure.destroy(); }
}

export function classifyMediaHttpError(status) {
  if (status === 401) return 'MEDIA_AUTH_REQUIRED';
  if (status === 403) return 'MEDIA_HTTP_FORBIDDEN';
  if (status === 404 || status === 410) return 'MEDIA_UNAVAILABLE';
  if (status === 429) return 'MEDIA_RATE_LIMITED';
  if (status >= 500 && status <= 599) return 'MEDIA_FETCH_FAILED';
  return 'MEDIA_HTTP_FAILED';
}

function collectBody(stream, status, headers, maximum, resolve, reject, isComplete, destination) {
  if ([301, 302, 303, 307, 308].includes(status)) { const redirect = headers.location; if (!redirect) reject(new Error('MEDIA_REDIRECT_DENIED')); else resolve({ redirect }); stream.destroy(); return; }
  if (status !== 200) { reject(new Error(classifyMediaHttpError(status))); stream.destroy(); return; }
  if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') { reject(new Error('MEDIA_FORMAT_UNSUPPORTED')); stream.destroy(); return; }
  const declared = headers['content-length'];
  if (declared !== undefined && !/^\d+$/.test(declared)) { reject(new Error('MEDIA_TOO_LARGE')); stream.destroy(); return; }
  if (declared !== undefined && Number(declared) > maximum) { reject(new Error(destination ? 'MEDIA_DISK_FULL' : 'MEDIA_TOO_LARGE')); stream.destroy(); return; }
  if (destination) {
    void collectFile(stream, destination, declared, maximum, isComplete).then(resolve, reject);
    return;
  }
  let size = 0; const chunks = [];
  stream.on('data', chunk => { size += chunk.length; if (size > maximum) { reject(new Error('MEDIA_TOO_LARGE')); stream.destroy(); return; } chunks.push(chunk); });
  stream.once('error', () => reject(new Error('MEDIA_PARTIAL_BODY')));
  stream.once('aborted', () => reject(new Error('MEDIA_PARTIAL_BODY')));
  stream.once('end', () => { if (!isComplete() || !size || (declared !== undefined && size !== Number(declared))) reject(new Error('MEDIA_PARTIAL_BODY')); else resolve({ body: Buffer.concat(chunks, size) }); });
}

async function collectFile(stream, destination, declared, maximum, isComplete) {
  let size = 0; let prefix = Buffer.alloc(0);
  const counter = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > maximum) { callback(new Error('MEDIA_DISK_FULL')); return; }
    if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0, 32 - prefix.length)]);
    callback(undefined, chunk);
  } });
  try {
    await pipeline(stream, counter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (!isComplete() || !size || (declared !== undefined && size !== Number(declared))) throw new Error('MEDIA_PARTIAL_BODY');
    return { filePath: destination, prefix, size };
  } catch (error) {
    await fs.unlink(destination).catch(() => {});
    if (error.code === 'ENOSPC') throw new Error('MEDIA_DISK_FULL', { cause: error });
    throw error;
  }
}

async function run() {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw new Error('MEDIA_INPUT_DENIED'); }
  const result = await fetchMedia(JSON.parse(input));
  if (result.filePath) { process.stdout.end(JSON.stringify(result)); return; }
  const metadata = Buffer.from(JSON.stringify(result.metadata));
  const header = Buffer.alloc(8); header.write('ERMS'); header.writeUInt32LE(metadata.length, 4);
  await new Promise((resolve, reject) => { process.stdout.once('error', reject); process.stdout.end(Buffer.concat([header, metadata, result.body]), resolve); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href || !process.argv[1]) {
  const watchdog = setTimeout(() => process.exit(1), FILE_TIMEOUT_MS + 1000);
  run().catch(error => { const code = /^MEDIA_[A-Z_]+$/.test(error.message) ? error.message : 'MEDIA_FETCH_FAILED'; process.stderr.write(code); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
}
