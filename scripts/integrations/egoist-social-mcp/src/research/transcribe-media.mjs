import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { assertSafeDirectory, assertSafeFile, safeOutputName, ResearchBrokerError } from './job-store.mjs';

const MAX_INPUT_BYTES = 1024 ** 3;
const MAX_JOB_BYTES = 2 * 1024 ** 3;
const MAX_RESULT_BYTES = 16 * 1024 ** 2;
const RESERVE_BYTES = 1024 ** 3;
const FORMATS = 'mov,matroska,webm,mp3,ogg,wav,flac,aac';
const OUTPUT_NAMES = ['transcripts.jsonl', 'transcripts.md', 'transcription-manifest.json'];
const TYPES = {
  'video/mp4': ['.mp4'], 'video/webm': ['.webm'], 'video/quicktime': ['.mov'],
  'audio/mp4': ['.m4a'], 'audio/mpeg': ['.mp3'], 'audio/ogg': ['.ogg', '.opus'],
  'audio/wav': ['.wav'], 'audio/x-wav': ['.wav'], 'audio/flac': ['.flac'],
  'audio/aac': ['.aac'], 'audio/webm': ['.webm'],
};
const REQUIRED_FLAGS = ['--output-json', '--output-file', '--language', '--no-gpu', '--no-prints', '--threads', '--duration', '--model', '--file'];
const error = code => new ResearchBrokerError(code, code);
const sameEntry = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
const diskFreeDefault = async directory => { const stat = await fs.statfs(directory); return stat.bavail * stat.bsize; };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function checkActive(signal, stopAt, now = Date.now) {
  if (signal?.aborted) throw error('CANCELLED');
  if (now() >= stopAt) throw error('DEADLINE_EXCEEDED');
}

/** No shell, desktop window, inherited reporting configuration, or generic diagnostics. */
async function runOwnedProcess(executable, args, { signal, timeoutMs, maxStdout = 128 * 1024, spawnProcess = spawn } = {}) {
  if (signal?.aborted) throw error('CANCELLED');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw error('DEADLINE_EXCEEDED');
  return new Promise((resolve, reject) => {
    let child;
    let failure;
    let size = 0;
    let stderrSize = 0;
    const stdout = [];
    const stderr = [];
    const environment = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'COMSPEC', 'ComSpec'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    environment.PATH = [path.dirname(executable), process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : ''].filter(Boolean).join(path.delimiter);
    try { child = spawnProcess(executable, args, { cwd: path.dirname(executable), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: environment }); }
    catch { reject(error('TRANSCRIPTION_PROCESS_FAILED')); return; }
    const terminate = code => {
      if (failure) return;
      failure = error(code);
      // This is the exact ChildProcess handle created above, never a process-name/PID search.
      try { child.kill(); } catch { /* The owned child may already have exited. */ }
    };
    const cancel = () => terminate('CANCELLED');
    const timer = setTimeout(() => terminate('DEADLINE_EXCEEDED'), Math.min(timeoutMs, 300_000));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > maxStdout) { terminate('TRANSCRIPTION_RESULT_LIMIT'); return; }
      stdout.push(bytes);
    });
    // Drain bounded diagnostics, including libraries that ignore --no-prints. They are not logged.
    child.stderr.on('data', bytes => {
      if (stderrSize < 128 * 1024) { stderr.push(bytes.subarray(0, 128 * 1024 - stderrSize)); stderrSize += bytes.length; }
    });
    child.once('error', () => { failure ??= error('TRANSCRIPTION_PROCESS_FAILED'); });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0) reject(error('TRANSCRIPTION_PROCESS_FAILED'));
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

async function hashRegularFile(file, expected, { signal, stopAt = Infinity, now = Date.now } = {}) {
  const checked = await assertSafeFile(file);
  if (expected && !sameIdentity(checked, expected)) throw error('UNSAFE_PATH');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  try {
    const opened = await handle.stat();
    if (!sameIdentity(checked, opened) || opened.nlink !== 1) throw error('UNSAFE_PATH');
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < opened.size) {
      checkActive(signal, stopAt, now);
      const result = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (!result.bytesRead) throw error('UNSAFE_PATH');
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    if (!sameIdentity(opened, await handle.stat()) || !sameIdentity(opened, await assertSafeFile(file))) throw error('UNSAFE_PATH');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

function runtimeRoots() {
  return [
    path.join(os.homedir(), 'AppData', 'Local', 'Egoist Relay', 'runtime'),
    path.join(os.homedir(), 'Desktop', 'Проекты', 'Приложения', 'Egoist Relay', 'runtime'),
  ];
}

async function selectRuntime(deps = {}) {
  for (const root of deps.runtimeRoots ?? runtimeRoots()) {
    const tools = {
      ffmpeg: path.join(root, 'media', 'ffmpeg.exe'), ffprobe: path.join(root, 'media', 'ffprobe.exe'),
      whisper: path.join(root, 'transcription', 'whisper-cli.exe'), model: path.join(root, 'transcription', 'ggml-small-q5_1.bin'),
      vadModel: path.join(root, 'transcription', 'ggml-silero-v6.2.0.bin'),
    };
    try {
      const identities = {};
      for (const key of ['ffmpeg', 'ffprobe', 'whisper', 'model']) {
        identities[key] = await assertSafeFile(tools[key]);
        if (identities[key].size < 1 || identities[key].size > 512 * 1024 ** 2) throw error('TRANSCRIPTION_UNAVAILABLE');
      }
      try { identities.vadModel = await assertSafeFile(tools.vadModel); } catch { tools.vadModel = undefined; }
      return { tools, identities };
    } catch { /* A missing runtime is unavailable; no installation or model download is attempted. */ }
  }
  throw error('TRANSCRIPTION_UNAVAILABLE');
}

async function inspectRuntime({ signal, stopAt, now = Date.now } = {}, deps = {}) {
  const runtime = await selectRuntime(deps);
  const processRunner = deps.runProcess ?? runOwnedProcess;
  const options = () => ({ signal, timeoutMs: Math.min(5000, stopAt - now()), maxStdout: 128 * 1024, spawnProcess: deps.spawnProcess });
  checkActive(signal, stopAt, now);
  const help = await processRunner(runtime.tools.whisper, ['--help'], options());
  const helpText = Buffer.concat([help.stdout, help.stderr]).toString('utf8');
  if (REQUIRED_FLAGS.some(flag => !helpText.includes(flag))) throw error('TRANSCRIPTION_RUNTIME_UNSUPPORTED');
  const version = await processRunner(runtime.tools.whisper, ['--version'], options());
  runtime.version = Buffer.concat([version.stdout, version.stderr]).toString('utf8').match(/whisper\.cpp version:\s*([0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?)/i)?.[1];
  if (!runtime.version) throw error('TRANSCRIPTION_RUNTIME_UNSUPPORTED');
  runtime.hasVad = Boolean(runtime.tools.vadModel && helpText.includes('--vad') && helpText.includes('--vad-model'));
  return runtime;
}

/** Static runtime readiness only; this does not inspect accounts or advertise account access. */
export async function getTranscriptionCapabilities(deps = {}) {
  try {
    const runtime = await inspectRuntime({ stopAt: Date.now() + 10_000 }, deps);
    return { available: true, engine: 'whisper.cpp', version: runtime.version, model: 'ggml-small-q5_1', multilingual: true, vadAvailable: runtime.hasVad,
      limits: { maxFiles: 20, maxDurationSeconds: 600, maxFileBytes: MAX_INPUT_BYTES, maxJobBytes: MAX_JOB_BYTES, reserveBytes: RESERVE_BYTES },
      mediaTypes: Object.keys(TYPES), accountAccessVerified: false };
  } catch (caught) {
    return { available: false, reason: caught.code === 'TRANSCRIPTION_RUNTIME_UNSUPPORTED' ? 'transcription_runtime_unsupported' : 'transcription_runtime_unavailable', accountAccessVerified: false };
  }
}

function parseProbe(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw error('TRANSCRIPTION_MEDIA_INVALID'); }
  if (!isObject(value) || !Array.isArray(value.streams) || value.streams.length > 1000 || !isObject(value.format)) throw error('TRANSCRIPTION_MEDIA_INVALID');
  const audio = value.streams.find(stream => stream.codec_type === 'audio');
  if (!audio) throw error('TRANSCRIPTION_NO_AUDIO');
  const duration = Number(audio.duration ?? value.format.duration);
  const channels = Number(audio.channels);
  const sampleRate = Number(audio.sample_rate);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7 * 24 * 60 * 60 || !Number.isInteger(channels) || channels < 1 || channels > 32 || !Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384_000 || typeof audio.codec_name !== 'string' || !/^[a-z0-9_]{1,80}$/i.test(audio.codec_name)) throw error('TRANSCRIPTION_MEDIA_INVALID');
  return { sourceDurationSeconds: duration, codec: audio.codec_name, channels, sampleRate };
}

function decodedPcmDuration(bytes, maximumSeconds) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw error('TRANSCRIPTION_MEDIA_INVALID');
  let validFormat = false;
  for (let position = 12; position + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', position, position + 4);
    const size = bytes.readUInt32LE(position + 4);
    const start = position + 8;
    if (kind === 'fmt ') {
      if (size < 16 || start + size > bytes.length || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 16000 || bytes.readUInt32LE(start + 8) !== 32000 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) throw error('TRANSCRIPTION_MEDIA_INVALID');
      validFormat = true;
    } else if (kind === 'data') {
      const actualSize = size === 0xffffffff ? bytes.length - start : size;
      const seconds = actualSize / 32000;
      if (!validFormat || actualSize < 160 || actualSize % 2 || start + actualSize > bytes.length || seconds > maximumSeconds + 0.25) throw error('TRANSCRIPTION_MEDIA_INVALID');
      return seconds;
    }
    if (size > bytes.length - start) throw error('TRANSCRIPTION_MEDIA_INVALID');
    position = start + size + (size % 2);
  }
  throw error('TRANSCRIPTION_MEDIA_INVALID');
}

function parseWhisperResult(bytes, processedDurationSeconds) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw error('TRANSCRIPTION_RESULT_INVALID'); }
  if (!isObject(value) || !Array.isArray(value.transcription) || value.transcription.length > 50_000 || !isObject(value.result) || typeof value.result.language !== 'string' || !/^[a-z]{2,3}$/.test(value.result.language)) throw error('TRANSCRIPTION_RESULT_INVALID');
  const segments = [];
  let previousStart = 0;
  let textBytes = 0;
  for (const segment of value.transcription) {
    if (!isObject(segment) || typeof segment.text !== 'string' || !isObject(segment.offsets)) throw error('TRANSCRIPTION_RESULT_INVALID');
    const startMs = segment.offsets.from;
    const endMs = segment.offsets.to;
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < previousStart || endMs < startMs || endMs > Math.ceil(processedDurationSeconds * 1000) + 250) throw error('TRANSCRIPTION_RESULT_INVALID');
    previousStart = startMs;
    const text = segment.text.trim();
    if (!text) continue;
    textBytes += Buffer.byteLength(text);
    if (textBytes > 8 * 1024 ** 2) throw error('TRANSCRIPTION_RESULT_LIMIT');
    segments.push({ startMs, endMs, text });
  }
  if (!segments.length) throw error('TRANSCRIPTION_NO_SPEECH');
  return { language: value.result.language, segments, text: segments.map(segment => segment.text).join(' ') };
}

/**
 * media must be the completed, owned download manifest, never user-selected filesystem paths.
 * deps is an in-process test seam only and is not a tool parameter or executable configuration.
 */
export async function transcribeDownloadedMedia({ outputDirectory, media, signal, deadlineMs, language = 'auto', maxDurationSeconds = 600, onCheckpoint = async () => {} }, deps = {}) {
  if (!Array.isArray(media) || !media.length || media.length > 20 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000 || typeof language !== 'string' || !/^(?:auto|[a-z]{2,3})$/.test(language) || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || maxDurationSeconds > 600 || typeof onCheckpoint !== 'function') throw error('INVALID_INPUT');
  const now = deps.now ?? Date.now;
  const stopAt = now() + deadlineMs;
  const diskFree = deps.diskFree ?? diskFreeDefault;
  const processRunner = deps.runProcess ?? runOwnedProcess;
  const originalDirectory = (await assertSafeDirectory(outputDirectory)).stat;
  async function verifyDirectory() {
    const current = (await assertSafeDirectory(outputDirectory)).stat;
    if (current.ino !== originalDirectory.ino || current.dev !== originalDirectory.dev) throw error('UNSAFE_PATH');
  }
  const selected = [];
  const unique = new Set();
  const mediaIds = new Set();
  let totalBytes = 0;
  for (const item of media) {
    if (!isObject(item) || typeof item.mediaId !== 'string' || !item.mediaId.length || item.mediaId.length > 128 || mediaIds.has(item.mediaId) || !safeOutputName(item.file) || unique.has(item.file.toLowerCase()) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_INPUT_BYTES || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || typeof item.mimeType !== 'string' || item.mimeType.length > 100 || item.sourceUrl !== undefined && (typeof item.sourceUrl !== 'string' || item.sourceUrl.length > 4096)) throw error('INVALID_INPUT');
    unique.add(item.file.toLowerCase());
    mediaIds.add(item.mediaId);
    totalBytes += item.bytes;
    if (totalBytes > MAX_JOB_BYTES) throw error('TRANSCRIPTION_INPUT_LIMIT');
    const sourcePath = path.join(outputDirectory, item.file);
    const identity = await assertSafeFile(sourcePath);
    if (identity.size !== item.bytes) throw error('UNSAFE_PATH');
    selected.push({ ...item, sourcePath, identity });
  }
  for (const name of OUTPUT_NAMES) if (await assertSafeFile(path.join(outputDirectory, name), { optional: true })) throw error('TRANSCRIPTION_OUTPUT_EXISTS');
  const files = [];
  const items = [];
  let count = 0;
  let segmentCount = 0;
  let transcriptBytes = 0;
  let jsonHandle;
  let markdownHandle;
  let runtime;
  let reason;
  const retainedTemporaryFiles = [];
  async function writeNew(name, bytes) {
    await verifyDirectory();
    if (await diskFree(outputDirectory) < RESERVE_BYTES + bytes.length) throw error('DISK_RESERVE');
    const handle = await fs.open(path.join(outputDirectory, name), 'wx', 0o600);
    files.push(name);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  try { runtime = await inspectRuntime({ signal, stopAt, now }, deps); }
  catch (caught) { reason = caught.code ?? 'TRANSCRIPTION_UNAVAILABLE'; }
  if (runtime) {
    runtime.modelSha256 = await hashRegularFile(runtime.tools.model, runtime.identities.model, { signal, stopAt, now }).catch(caught => { reason = caught.code; return undefined; });
  }
  for (const item of selected) {
    const summary = { mediaId: item.mediaId, file: item.file, sha256: item.sha256 };
    const temporaries = new Map();
    const temporaryCandidates = new Set();
    try {
      if (reason) throw error(reason);
      checkActive(signal, stopAt, now);
      if (!TYPES[item.mimeType]?.includes(path.extname(item.file).toLowerCase())) throw error('TRANSCRIPTION_MEDIA_UNSUPPORTED');
      await verifyDirectory();
      if (await hashRegularFile(item.sourcePath, item.identity, { signal, stopAt, now }) !== item.sha256) throw error('TRANSCRIPTION_SOURCE_MISMATCH');
      const opts = maxStdout => ({ signal, timeoutMs: stopAt - now(), maxStdout, spawnProcess: deps.spawnProcess });
      const probe = await processRunner(runtime.tools.ffprobe, ['-hide_banner', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS, '-show_entries', 'format=duration,format_name:stream=index,codec_type,codec_name,duration,sample_rate,channels', '-of', 'json', item.sourcePath], opts(128 * 1024));
      const audio = parseProbe(probe.stdout);
      const requestedDurationSeconds = Math.min(audio.sourceDurationSeconds, maxDurationSeconds);
      const maximumAudio = Math.ceil(requestedDurationSeconds * 32_000) + 16 * 1024;
      if (await diskFree(outputDirectory) < RESERVE_BYTES + maximumAudio + MAX_RESULT_BYTES) throw error('DISK_RESERVE');
      const wav = await processRunner(runtime.tools.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS, '-i', item.sourcePath, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(requestedDurationSeconds), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], opts(maximumAudio));
      const decodedDurationSeconds = decodedPcmDuration(wav.stdout, requestedDurationSeconds);
      const processedDurationSeconds = Math.min(decodedDurationSeconds, requestedDurationSeconds);
      if (!sameIdentity(item.identity, await assertSafeFile(item.sourcePath))) throw error('UNSAFE_PATH');
      checkActive(signal, stopAt, now);
      await verifyDirectory();
      const prefix = path.join(outputDirectory, `transcription-work-${randomUUID()}`);
      const wavPath = prefix + '.wav';
      const resultPath = prefix + '.json';
      temporaryCandidates.add(wavPath);
      temporaryCandidates.add(resultPath);
      const wavHandle = await fs.open(wavPath, 'wx', 0o600);
      try { temporaries.set(wavPath, await wavHandle.stat()); await wavHandle.writeFile(wav.stdout); await wavHandle.sync(); } finally { await wavHandle.close(); }
      if (await assertSafeFile(resultPath, { optional: true })) throw error('UNSAFE_PATH');
      for (const key of ['ffmpeg', 'ffprobe', 'whisper', 'model', ...(runtime.hasVad ? ['vadModel'] : [])]) if (!sameIdentity(runtime.identities[key], await assertSafeFile(runtime.tools[key]))) throw error('TRANSCRIPTION_RUNTIME_CHANGED');
      const args = ['-m', runtime.tools.model, '-f', wavPath, '-l', language, '-ng', '-oj', '-np', '-t', String(Math.min(4, Math.max(1, os.availableParallelism() - 1))), '-d', String(Math.ceil(processedDurationSeconds * 1000)), '-of', prefix];
      if (runtime.hasVad) args.push('--vad', '-vm', runtime.tools.vadModel);
      let whisperFailure;
      try { await processRunner(runtime.tools.whisper, args, opts(128 * 1024)); } catch (caught) { whisperFailure = caught; }
      // JSON output is generated only at an unpredictable exclusive-owned prefix. Never read symlinks.
      const resultIdentity = await assertSafeFile(resultPath, { optional: true });
      if (resultIdentity) { temporaries.set(resultPath, resultIdentity); if (resultIdentity.size > MAX_RESULT_BYTES) throw error('TRANSCRIPTION_RESULT_LIMIT'); }
      if (whisperFailure) throw whisperFailure;
      if (!resultIdentity) throw error('TRANSCRIPTION_RESULT_INVALID');
      checkActive(signal, stopAt, now);
      const bytes = await fs.readFile(resultPath);
      if (bytes.length > MAX_RESULT_BYTES || !sameIdentity(resultIdentity, await assertSafeFile(resultPath))) throw error('TRANSCRIPTION_RESULT_LIMIT');
      const transcript = parseWhisperResult(bytes, processedDurationSeconds);
      const truncated = audio.sourceDurationSeconds - requestedDurationSeconds > 0.01;
      const decodedShort = requestedDurationSeconds - decodedDurationSeconds > 0.25;
      const incompleteReason = truncated ? 'duration_limited' : decodedShort ? 'decoded_audio_shorter_than_metadata' : undefined;
      const record = { schemaVersion: 1, ...summary, sourceUrl: item.sourceUrl, mimeType: item.mimeType, ...transcript, audio: { ...audio, processedDurationSeconds, decodedDurationSeconds },
        engine: { name: 'whisper.cpp', version: runtime.version, model: 'ggml-small-q5_1', modelSha256: runtime.modelSha256, vad: runtime.hasVad },
        completeness: { state: incompleteReason ?? 'complete', coveredStartMs: 0, coveredEndMs: Math.ceil(processedDurationSeconds * 1000), missingSeconds: Math.max(0, audio.sourceDurationSeconds - processedDurationSeconds), timestampKind: 'model_estimate', accuracyVerified: false } };
      const line = Buffer.from(JSON.stringify(record) + '\n');
      const md = Buffer.from(`## ${item.file}\n\nMedia SHA-256: ${item.sha256}\n\nLanguage: ${transcript.language}; coverage: ${record.completeness.state}; timestamps are model estimates.\n\n${transcript.segments.map(segment => `[${segment.startMs / 1000}–${segment.endMs / 1000}s] ${segment.text}`).join('\n\n')}\n\n`);
      transcriptBytes += line.length + md.length;
      if (transcriptBytes > MAX_RESULT_BYTES) throw error('TRANSCRIPTION_RESULT_LIMIT');
      if (await diskFree(outputDirectory) < RESERVE_BYTES + line.length + md.length) throw error('DISK_RESERVE');
      await verifyDirectory();
      if (!jsonHandle) { jsonHandle = await fs.open(path.join(outputDirectory, OUTPUT_NAMES[0]), 'wx', 0o600); files.push(OUTPUT_NAMES[0]); }
      await jsonHandle.writeFile(line);
      await jsonHandle.sync();
      count++;
      segmentCount += transcript.segments.length;
      items.push({ ...summary, state: incompleteReason ? 'partial' : 'completed', reason: incompleteReason, language: transcript.language, segmentCount: transcript.segments.length, sourceDurationSeconds: audio.sourceDurationSeconds, processedDurationSeconds });
      if (!markdownHandle) { markdownHandle = await fs.open(path.join(outputDirectory, OUTPUT_NAMES[1]), 'wx', 0o600); files.push(OUTPUT_NAMES[1]); }
      await markdownHandle.writeFile(md);
      await markdownHandle.sync();
      await onCheckpoint({ state: items.some(value => value.state !== 'completed') ? 'partial' : 'completed', count, segmentCount, files: [...files] });
    } catch (caught) {
      const code = typeof caught.code === 'string' && /^[A-Z_]{1,96}$/.test(caught.code) ? caught.code : 'TRANSCRIPTION_FAILED';
      const accepted = items.find(value => value.file === item.file);
      if (accepted) { accepted.state = 'partial'; accepted.reason = code.toLowerCase(); reason ??= code; }
      else items.push({ ...summary, state: ['TRANSCRIPTION_MEDIA_UNSUPPORTED', 'TRANSCRIPTION_NO_AUDIO', 'TRANSCRIPTION_NO_SPEECH', 'TRANSCRIPTION_UNAVAILABLE', 'TRANSCRIPTION_RUNTIME_UNSUPPORTED'].includes(code) ? 'unsupported' : 'partial', reason: code.toLowerCase() });
      if (['CANCELLED', 'DEADLINE_EXCEEDED', 'DISK_RESERVE', 'TRANSCRIPTION_RUNTIME_CHANGED', 'UNSAFE_PATH'].includes(code)) reason = code;
    } finally {
      for (const [file, identity] of temporaries) {
        try {
          await verifyDirectory();
          const current = await assertSafeFile(file);
          if (sameEntry(identity, current)) await fs.unlink(file);
        } catch { /* Never remove a replaced path; report uncertain cleanup below. */ }
      }
      // Readback of exact known paths detects any retained temporary without deleting someone else's file.
      for (const file of temporaryCandidates) {
        try { await fs.lstat(file); retainedTemporaryFiles.push(path.basename(file)); reason ??= 'TRANSCRIPTION_TEMP_RETAINED'; } catch (caught) { if (caught.code !== 'ENOENT') { retainedTemporaryFiles.push(path.basename(file)); reason ??= 'TRANSCRIPTION_TEMP_RETAINED'; } }
      }
    }
  }
  await jsonHandle?.close();
  await markdownHandle?.close();
  const state = !reason && count === selected.length && items.every(item => item.state === 'completed') ? 'completed' : count === 0 && items.every(item => item.state === 'unsupported') ? 'unsupported' : 'partial';
  const manifest = { schemaVersion: 1, state, reason: reason?.toLowerCase(), count, segmentCount, selectedCount: selected.length, items,
    files: [...files], retainedTemporaryFiles, engine: runtime ? { name: 'whisper.cpp', version: runtime.version, model: 'ggml-small-q5_1', modelSha256: runtime.modelSha256 } : undefined,
    limits: { deadlineMs, maxDurationSeconds, reserveBytes: RESERVE_BYTES, maxInputBytes: MAX_INPUT_BYTES, maxJobBytes: MAX_JOB_BYTES, maxTranscriptBytes: MAX_RESULT_BYTES }, completedAt: new Date().toISOString(), accuracyVerified: false };
  await writeNew(OUTPUT_NAMES[2], Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  await onCheckpoint({ state, count, segmentCount, files: [...files] });
  return { state, count, segmentCount, files, items, ...(retainedTemporaryFiles.length ? { retainedTemporaryFiles } : {}), ...(reason ? { reason: reason.toLowerCase() } : {}) };
}
