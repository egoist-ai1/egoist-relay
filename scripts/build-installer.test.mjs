import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildInstaller, encodeTail, mergeManifest, mergeSums, validatePayloadName } from './build-installer.mjs';

const project = path.resolve(import.meta.dirname, '..');
const realStub = path.join(project, 'installer/target/release/Sennit-Setup.exe');

test('payloadName: те же правила, что в Rust', () => {
  for (const ok of ['Sennit-Payload-1.7.1.exe', 'a_b-c.1']) validatePayloadName(ok);
  for (const bad of ['', '.hidden', '..\\evil.exe', 'a/b', 'a b', 'x'.repeat(81), 'имя.exe', undefined]) assert.throws(() => validatePayloadName(bad), bad);
  assert.throws(() => encodeTail({ payloadOffset: 1, payloadLen: 1, installBytes: 1, payloadSha256: Buffer.alloc(32), meta: { product: 'S', version: '1', payloadName: '..\\x', builtAt: 't' } }));
});

test('SHA256SUMS.txt и manifest.json: чужие записи и поля сохраняются', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sennit-merge-'));
  try {
    const sums = path.join(dir, 'SHA256SUMS.txt');
    await writeFile(sums, `${'a'.repeat(64)} *Old Raw Setup.exe
${'b'.repeat(64)} *Sennit-Setup-1.7.1.exe
`);
    await mergeSums(sums, 'Sennit-Setup-1.7.1.exe', 'c'.repeat(64));
    assert.equal(await readFile(sums, 'utf8'), `${'a'.repeat(64)} *Old Raw Setup.exe
${'c'.repeat(64)} *Sennit-Setup-1.7.1.exe
`);
    await mergeSums(sums, 'Other.exe', 'd'.repeat(64));
    assert.equal((await readFile(sums, 'utf8')).trim().split('\n').length, 3);
    const manifest = path.join(dir, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, package: 'NSIS', installer: { fileName: 'raw.exe' }, executable: { fileName: 'Egoist Relay.exe' } }));
    await mergeManifest(manifest, { fileName: 'Sennit-Setup-1.7.1.exe' });
    const m = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(m.schemaVersion, 1);
    assert.equal(m.installer.fileName, 'raw.exe');
    assert.equal(m.executable.fileName, 'Egoist Relay.exe');
    assert.equal(m.sfx.fileName, 'Sennit-Setup-1.7.1.exe');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('сборка атомарна: неудачная проверка не оставляет ни .part, ни итогового файла', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sennit-atomic-'));
  try {
    const stub = path.join(dir, 'stub.exe');
    const payload = path.join(dir, 'payload.bin');
    await writeFile(stub, Buffer.from('not a real executable'));
    await writeFile(payload, Buffer.alloc(1000, 7));
    await assert.rejects(buildInstaller({ stub, payload, outDir: dir, version: '1.7.1', installBytes: 1 }), /--verify/);
    assert.equal(existsSync(path.join(dir, 'Sennit-Setup-1.7.1.exe.part')), false);
    assert.equal(existsSync(path.join(dir, 'Sennit-Setup-1.7.1.exe')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('хвост: размеры, сигнатуры и контрольная сумма', () => {
  const sha = createHash('sha256').update('x').digest();
  const tail = encodeTail({ payloadOffset: 10, payloadLen: 1, installBytes: 5, payloadSha256: sha, meta: { product: 'Sennit', version: '1.7.1', payloadName: 'p.exe', builtAt: 'now' } });
  const t = tail.subarray(tail.length - 128);
  assert.equal(t.subarray(0, 8).toString(), 'SENNITSX');
  assert.equal(t.subarray(120).toString(), 'XSTINNES');
  assert.equal(t.readBigUInt64LE(16), 10n);
  assert.equal(t.readBigUInt64LE(24), 1n);
  assert.equal(t.readUInt32LE(40), tail.length - 128);
  assert.deepEqual(t.subarray(48, 80), sha);
  const meta = tail.subarray(0, tail.length - 128);
  assert.deepEqual(t.subarray(80, 112), createHash('sha256').update(meta).update(t.subarray(0, 80)).digest());
});

test('сборка потоком: stub + payload + хвост, Rust --verify принимает файл и отвергает порчу',
  { skip: process.platform !== 'win32' || !existsSync(realStub) }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sennit-sfx-'));
    try {
      const payload = path.join(dir, 'payload.bin');
      await writeFile(payload, Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 31) % 251)));
      const r = await buildInstaller({ stub: realStub, payload, outDir: dir, version: '1.7.1', installBytes: 123456 });
      const verify = (file) => spawnSync(file, ['--verify'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      // Windows-GUI exe без консоли: код выхода и есть результат
      assert.equal(verify(r.outFile).status, 0);
      const bytes = await readFile(r.outFile);
      bytes[bytes.length - 128 - 80 - 200000] ^= 0xff; // порча внутри payload
      const bad = path.join(dir, 'bad.exe');
      await writeFile(bad, bytes);
      assert.equal(verify(bad).status, 10);
      const plain = path.join(dir, 'plain.exe');
      await copyFile(realStub, plain);
      assert.equal(verify(plain).status, 10);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
