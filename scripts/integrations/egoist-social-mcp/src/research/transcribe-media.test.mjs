import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { transcribeDownloadedMedia, getTranscriptionCapabilities } from './transcribe-media.mjs';

const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !path.isAbsolute(work)) throw new Error('Owned task work is required');
const helpText = '--output-json --output-file --language --no-gpu --no-prints --threads --duration --model --file';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const probeValue = { streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 }], format: { duration: '2.0', format_name: 'wav' } };
const resultValue = { result: { language: 'ru' }, transcription: [{ offsets: { from: 0, to: 1000 }, text: 'Проверка🙂' }, { offsets: { from: 1000, to: 2000 }, text: ' локального распознавания.' }] };
function pcmWav(seconds) {
  const dataBytes = seconds * 32000;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}
const wavBytes = pcmWav(2);

async function fixture(options = {}) {
  const base = path.join(work, `transcription-fixture-${randomUUID()}`);
  const outputDirectory = path.join(base, 'job');
  const runtime = path.join(base, 'runtime');
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const file of ['media/ffmpeg.exe', 'media/ffprobe.exe', 'transcription/whisper-cli.exe', 'transcription/ggml-small-q5_1.bin']) {
    const target = path.join(runtime, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'synthetic-runtime');
  }
  const media = [];
  for (let index = 0; index < (options.mediaCount ?? 1); index++) {
    const file = `media-${index + 1}.wav`;
    const bytes = Buffer.from(`synthetic-media-${index}`);
    await fs.writeFile(path.join(outputDirectory, file), bytes);
    media.push({ mediaId: `fixture-${index}`, file, bytes: bytes.length, sha256: hash(bytes), mimeType: 'audio/wav', sourceUrl: 'https://t.me/synthetic/1' });
  }
  const controller = new AbortController();
  const calls = [];
  const checkpoints = [];
  const runner = async (executable, args, processOptions) => {
    const name = path.basename(executable);
    calls.push({ name, args, processOptions });
    if (args[0] === '--help') return { stdout: Buffer.from(options.help ?? helpText), stderr: Buffer.alloc(0) };
    if (args[0] === '--version') return { stdout: Buffer.from(options.version ?? 'whisper.cpp version: 1.9.4'), stderr: Buffer.alloc(0) };
    if (name === 'ffprobe.exe') {
      assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
      assert.ok(args.includes('-format_whitelist'));
      return { stdout: Buffer.from(JSON.stringify(await (options.probe?.(args, calls) ?? probeValue))), stderr: Buffer.alloc(0) };
    }
    if (name === 'ffmpeg.exe') {
      assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
      assert.equal(args.at(-1), 'pipe:1');
      assert.equal(args[args.indexOf('-ar') + 1], '16000');
      assert.equal(args[args.indexOf('-ac') + 1], '1');
      await options.afterExtract?.(outputDirectory);
      return { stdout: options.wav ?? wavBytes, stderr: Buffer.alloc(0) };
    }
    assert.equal(name, 'whisper-cli.exe');
    assert.ok(args.includes('-ng'));
    assert.ok(args.includes('-np'));
    const prefix = args[args.indexOf('-of') + 1];
    if (options.writeResult) await options.writeResult(prefix, outputDirectory);
    else await fs.writeFile(prefix + '.json', options.rawResult ?? JSON.stringify(options.result ?? resultValue), { flag: 'wx' });
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const deps = { runtimeRoots: [runtime], runProcess: runner, diskFree: async () => 10 * 1024 ** 3, ...options.deps };
  const run = extra => transcribeDownloadedMedia({ outputDirectory, media, signal: controller.signal, deadlineMs: 10_000,
    onCheckpoint: async value => { checkpoints.push(value); await options.checkpoint?.(value, controller); }, ...extra }, deps);
  return { base, outputDirectory, runtime, media, calls, deps, controller, checkpoints, run };
}

test('static capabilities verify fixed runtime flags/version and never claim account access', async () => {
  const f = await fixture();
  const result = await getTranscriptionCapabilities(f.deps);
  assert.equal(result.available, true); assert.equal(result.version, '1.9.4'); assert.equal(result.multilingual, true);
  assert.equal(result.accountAccessVerified, false); assert.equal(result.vadAvailable, false);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(call => call.args), [['--help'], ['--version']]);
});

test('timestamped Unicode transcripts bind source/model hashes, expose estimates and clean owned intermediates', async () => {
  const f = await fixture();
  const result = await f.run();
  assert.equal(result.state, 'completed'); assert.equal(result.count, 1); assert.equal(result.segmentCount, 2);
  const record = JSON.parse((await fs.readFile(path.join(f.outputDirectory, 'transcripts.jsonl'), 'utf8')).trim());
  assert.equal(record.sha256, f.media[0].sha256); assert.equal(record.engine.modelSha256, hash(Buffer.from('synthetic-runtime')));
  assert.equal(record.segments[0].text, 'Проверка🙂'); assert.deepEqual(record.segments[1], { startMs: 1000, endMs: 2000, text: 'локального распознавания.' });
  assert.equal(record.completeness.timestampKind, 'model_estimate'); assert.equal(record.completeness.accuracyVerified, false);
  assert.ok((await fs.readFile(path.join(f.outputDirectory, 'transcripts.md'), 'utf8')).includes('[1–2s]'));
  assert.equal((await fs.readdir(f.outputDirectory)).some(name => name.startsWith('transcription-work-')), false);
  assert.equal(JSON.stringify(result).includes('Проверка'), false);
  assert.equal(f.checkpoints.at(-1).count, 1);
});

test('missing tools and unsupported runtime flags report unavailable without downloads', async () => {
  const f = await fixture();
  assert.equal((await getTranscriptionCapabilities({ runtimeRoots: [path.join(f.base, 'missing')] })).available, false);
  const missing = await transcribeDownloadedMedia({ outputDirectory: f.outputDirectory, media: f.media, deadlineMs: 1000 }, { runtimeRoots: [path.join(f.base, 'missing')], diskFree: f.deps.diskFree });
  assert.equal(missing.state, 'unsupported'); assert.equal(missing.count, 0); assert.deepEqual(missing.files, ['transcription-manifest.json']);
  const invalid = await fixture({ help: '--help' });
  assert.equal((await getTranscriptionCapabilities(invalid.deps)).reason, 'transcription_runtime_unsupported');
});

test('arbitrary paths, ADS, reserved names and invalid controls never reach a media process', async () => {
  for (const file of ['../outside.wav', 'x:secret.wav', 'CON.wav', 'a/b.wav', 'C:\\outside.wav', 'trailing..']) {
    const f = await fixture();
    await assert.rejects(f.run({ media: [{ ...f.media[0], file }] }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture();
  for (const extra of [{ language: '--prompt' }, { deadlineMs: Infinity }, { maxDurationSeconds: 601 }, { media: [] }]) await assert.rejects(f.run(extra), { code: 'INVALID_INPUT' });
});

test('manifest byte identity and cryptographic mismatch block extraction', async () => {
  const f = await fixture();
  await assert.rejects(f.run({ media: [{ ...f.media[0], bytes: 1 }] }), { code: 'UNSAFE_PATH' });
  const result = await f.run({ media: [{ ...f.media[0], sha256: '0'.repeat(64) }] });
  assert.equal(result.state, 'partial'); assert.equal(result.items[0].reason, 'transcription_source_mismatch');
  assert.equal(f.calls.some(call => call.name === 'ffprobe.exe'), false);
});

test('hardlinked sources and junction ancestors are rejected before runtime access', async () => {
  const f = await fixture();
  await fs.link(path.join(f.outputDirectory, f.media[0].file), path.join(f.base, 'hardlink.wav'));
  await assert.rejects(f.run(), { code: 'UNSAFE_PATH' });
  assert.equal(f.calls.length, 0);
  const clean = await fixture();
  const alias = path.join(clean.base, 'alias');
  await fs.symlink(clean.outputDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(clean.run({ outputDirectory: alias }), { code: 'UNSAFE_PATH' });
});

test('case-insensitive duplicate files and duplicate media IDs are rejected', async () => {
  const f = await fixture({ mediaCount: 2 });
  await assert.rejects(f.run({ media: [f.media[0], { ...f.media[0], mediaId: 'different', file: f.media[0].file.toUpperCase() }] }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.run({ media: [f.media[0], { ...f.media[1], mediaId: f.media[0].mediaId }] }), { code: 'INVALID_INPUT' });
  assert.equal(f.calls.length, 0);
});

test('pictures and mismatched audio extensions are explicit unsupported results', async () => {
  const f = await fixture();
  const result = await f.run({ media: [{ ...f.media[0], mimeType: 'image/png' }] });
  assert.equal(result.state, 'unsupported'); assert.equal(result.items[0].reason, 'transcription_media_unsupported');
  assert.equal(f.calls.some(call => call.name === 'ffprobe.exe'), false);
});

test('actual probe with no audio is unsupported and unknown duration is a failure', async () => {
  const f = await fixture({ probe: () => ({ streams: [{ codec_type: 'video' }], format: { duration: '2' } }) });
  const result = await f.run();
  assert.equal(result.state, 'unsupported'); assert.equal(result.items[0].reason, 'transcription_no_audio');
  assert.equal(f.calls.some(call => call.name === 'ffmpeg.exe'), false);
  const unknown = await fixture({ probe: () => ({ ...probeValue, format: {} }) });
  assert.equal((await unknown.run()).items[0].reason, 'transcription_media_invalid');
});

test('decoded PCM format/length must be real and shorter audio coverage stays explicit', async () => {
  const malformed = await fixture({ wav: Buffer.from('RIFF1234WAVE') });
  assert.equal((await malformed.run()).items[0].reason, 'transcription_media_invalid');
  const wrongRate = Buffer.from(wavBytes); wrongRate.writeUInt32LE(48000, 24);
  const invalid = await fixture({ wav: wrongRate });
  assert.equal((await invalid.run()).items[0].reason, 'transcription_media_invalid');
  const short = await fixture({ wav: pcmWav(1), result: { result: { language: 'ru' }, transcription: [{ text: 'Коротко', offsets: { from: 0, to: 1000 } }] } });
  const result = await short.run();
  assert.equal(result.state, 'partial'); assert.equal(result.items[0].reason, 'decoded_audio_shorter_than_metadata');
  const record = JSON.parse((await fs.readFile(path.join(short.outputDirectory, 'transcripts.jsonl'), 'utf8')).trim());
  assert.equal(record.audio.decodedDurationSeconds, 1); assert.equal(record.completeness.missingSeconds, 1);
});

test('out of range/nonmonotonic timestamps and invalid result schema cannot count as accepted speech', async () => {
  for (const value of [
    { result: { language: 'ru' }, transcription: [{ text: 'bad', offsets: { from: -1, to: 1 } }] },
    { result: { language: 'ru' }, transcription: [{ text: 'bad', offsets: { from: 0, to: 9000 } }] },
    { result: { language: 'ru' }, transcription: [{ text: 'bad', offsets: { from: 1000, to: 1500 } }, { text: 'bad', offsets: { from: 500, to: 1000 } }] },
    { result: { language: 'ru' }, transcription: [{ text: 'bad' }] },
  ]) {
    const f = await fixture({ result: value });
    const result = await f.run();
    assert.equal(result.state, 'partial'); assert.equal(result.count, 0); assert.equal(result.items[0].reason, 'transcription_result_invalid');
    assert.equal((await fs.readdir(f.outputDirectory)).some(name => name.startsWith('transcription-work-')), false);
  }
});

test('no recognized speech never becomes a successful empty transcript', async () => {
  const f = await fixture({ result: { result: { language: 'ru' }, transcription: [] } });
  const result = await f.run();
  assert.equal(result.state, 'unsupported'); assert.equal(result.count, 0); assert.equal(result.items[0].reason, 'transcription_no_speech');
  assert.equal(result.files.includes('transcripts.jsonl'), false);
});

test('malformed UTF-8 is rejected instead of silently changing recognized text', async () => {
  const f = await fixture({ rawResult: Buffer.concat([Buffer.from('{"result":{"language":"ru"},"transcription":[{"offsets":{"from":0,"to":1000},"text":"'), Buffer.from([0xff]), Buffer.from('"}]}')]) });
  const result = await f.run();
  assert.equal(result.state, 'partial'); assert.equal(result.count, 0); assert.equal(result.items[0].reason, 'transcription_result_invalid');
});

test('an unsafe generated result is not read/deleted and its retained name is explicit', async () => {
  const f = await fixture({ writeResult: async (prefix, directory) => fs.link(path.join(directory, 'media-1.wav'), prefix + '.json') });
  const result = await f.run();
  assert.equal(result.state, 'partial'); assert.equal(result.count, 0); assert.equal(result.reason, 'unsafe_path');
  assert.equal(result.retainedTemporaryFiles.length, 1); assert.ok(result.retainedTemporaryFiles[0].endsWith('.json'));
  assert.equal(hash(await fs.readFile(path.join(f.outputDirectory, f.media[0].file))), f.media[0].sha256);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.outputDirectory, 'transcription-manifest.json'), 'utf8')).retainedTemporaryFiles.length, 1);
});

test('duration cap retains timestamps and explicit missing coverage', async () => {
  const f = await fixture({ probe: () => ({ ...probeValue, format: { duration: '10' } }) });
  const result = await f.run({ maxDurationSeconds: 2 });
  assert.equal(result.state, 'partial'); assert.equal(result.items[0].reason, 'duration_limited');
  assert.equal(f.calls.find(call => call.name === 'ffmpeg.exe').args.includes('2'), true);
  const record = JSON.parse((await fs.readFile(path.join(f.outputDirectory, 'transcripts.jsonl'), 'utf8')).trim());
  assert.equal(record.completeness.missingSeconds, 8); assert.equal(record.audio.processedDurationSeconds, 2);
});

test('preexisting output remains unchanged and is never overwritten', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.outputDirectory, 'transcripts.jsonl'), 'existing-owned-data');
  await assert.rejects(f.run(), { code: 'TRANSCRIPTION_OUTPUT_EXISTS' });
  assert.equal(await fs.readFile(path.join(f.outputDirectory, 'transcripts.jsonl'), 'utf8'), 'existing-owned-data');
  assert.equal(f.calls.length, 0);
});

test('accepted first transcript survives a later unavailable audio stream', async () => {
  let probes = 0;
  const f = await fixture({ mediaCount: 2, probe: () => ++probes === 1 ? probeValue : { streams: [], format: { duration: '2' } } });
  const result = await f.run();
  assert.equal(result.state, 'partial'); assert.equal(result.count, 1); assert.equal(result.items[1].reason, 'transcription_no_audio');
  assert.equal((await fs.readFile(path.join(f.outputDirectory, 'transcripts.jsonl'), 'utf8')).trim().split('\n').length, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(f.outputDirectory, 'transcription-manifest.json'), 'utf8'));
  assert.equal(manifest.count, 1); assert.equal(manifest.selectedCount, 2);
});

test('cancel after accepted transcript preserves it and does not start later media', async () => {
  const f = await fixture({ mediaCount: 2, checkpoint: (_, controller) => controller.abort() });
  const result = await f.run();
  assert.equal(result.state, 'partial'); assert.equal(result.count, 1); assert.equal(result.reason, 'cancelled');
  assert.equal(f.calls.filter(call => call.name === 'ffprobe.exe').length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.outputDirectory, 'transcription-manifest.json'), 'utf8')).count, 1);
});

test('disk reserve refuses extraction or output while preserving original media', async () => {
  const f = await fixture({ deps: { diskFree: async () => 0 } });
  await assert.rejects(f.run(), { code: 'DISK_RESERVE' });
  assert.equal(f.calls.some(call => call.name === 'ffmpeg.exe'), false);
  assert.deepEqual(await fs.readdir(f.outputDirectory), [f.media[0].file]);
});

test('a changed source identity after decoding cannot produce an accepted transcript', async () => {
  const f = await fixture({ afterExtract: async directory => fs.writeFile(path.join(directory, 'media-1.wav'), 'replaced') });
  const result = await f.run();
  assert.equal(result.state, 'partial'); assert.equal(result.count, 0); assert.equal(result.reason, 'unsafe_path');
  assert.equal(f.calls.some(call => call.name === 'whisper-cli.exe' && call.args.includes('-of')), false);
});

test('checkpoint/storage failure after acceptance retains bytes and reports partial', async () => {
  const f = await fixture({ checkpoint: () => { throw Object.assign(new Error('synthetic'), { code: 'STORAGE_FAILED' }); } });
  await assert.rejects(f.run(), { code: 'STORAGE_FAILED' });
  const record = JSON.parse((await fs.readFile(path.join(f.outputDirectory, 'transcripts.jsonl'), 'utf8')).trim());
  assert.equal(record.mediaId, f.media[0].mediaId);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.outputDirectory, 'transcription-manifest.json'), 'utf8')).state, 'partial');
});

function fakeSpawn(f, { cancel = false } = {}) {
  const spawned = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = 0;
    child.kill = () => { child.kills++; queueMicrotask(() => child.emit('close', 1)); return true; };
    spawned.push({ child, executable, args, options });
    queueMicrotask(() => {
      if (path.basename(executable) === 'whisper-cli.exe' && args.includes('-of')) {
        if (cancel) setTimeout(() => f.controller.abort(), 20);
        return;
      }
      let bytes = Buffer.alloc(0);
      if (args[0] === '--help') bytes = Buffer.from(helpText);
      else if (args[0] === '--version') bytes = Buffer.from('whisper.cpp version: 1.9.4');
      else if (path.basename(executable) === 'ffprobe.exe') bytes = Buffer.from(JSON.stringify(probeValue));
      else if (path.basename(executable) === 'ffmpeg.exe') bytes = wavBytes;
      child.stdout.end(bytes); child.stderr.end(); child.emit('close', 0);
    });
    return child;
  };
  return { spawnProcess, spawned };
}

test('cancellation terminates only the exact hidden owned child and drains bounded output', async () => {
  const f = await fixture();
  const { spawnProcess, spawned } = fakeSpawn(f, { cancel: true });
  const result = await transcribeDownloadedMedia({ outputDirectory: f.outputDirectory, media: f.media, deadlineMs: 1000, signal: f.controller.signal }, { runtimeRoots: [f.runtime], diskFree: f.deps.diskFree, spawnProcess });
  assert.equal(result.reason, 'cancelled'); assert.equal(result.count, 0);
  assert.equal(spawned.length, 5); assert.equal(spawned.at(-1).child.kills, 1); assert.ok(spawned.slice(0, -1).every(entry => entry.child.kills === 0));
  assert.ok(spawned.every(entry => entry.options.windowsHide === true && entry.options.shell === false && !('FFREPORT' in entry.options.env)));
  assert.equal((await fs.readdir(f.outputDirectory)).some(name => name.startsWith('transcription-work-')), false);
});

test('deadline terminates the owned hanging process, preserves source and writes a partial manifest', async () => {
  const f = await fixture();
  const { spawnProcess, spawned } = fakeSpawn(f);
  const result = await transcribeDownloadedMedia({ outputDirectory: f.outputDirectory, media: f.media, deadlineMs: 250 }, { runtimeRoots: [f.runtime], diskFree: f.deps.diskFree, spawnProcess });
  assert.equal(result.reason, 'deadline_exceeded'); assert.equal(result.state, 'partial');
  assert.equal(spawned.at(-1).child.kills, 1);
  assert.equal(hash(await fs.readFile(path.join(f.outputDirectory, f.media[0].file))), f.media[0].sha256);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.outputDirectory, 'transcription-manifest.json'), 'utf8')).state, 'partial');
});
