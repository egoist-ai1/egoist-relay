import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildInstaller, describeProvisioning, encodeTail, loadProvisioning, mergeManifest, mergeSums, validatePayloadName, validateProvisioning } from './build-installer.mjs';

const project = path.resolve(import.meta.dirname, '..');
const realStub = path.join(project, 'installer/target/release/Egoist-Social-Setup.exe');

test('payloadName: те же правила, что в Rust', () => {
  for (const ok of ['Egoist-Social-Payload-1.7.1.exe', 'a_b-c.1']) validatePayloadName(ok);
  for (const bad of ['', '.hidden', '..\\evil.exe', 'a/b', 'a b', 'x'.repeat(81), 'имя.exe', undefined]) assert.throws(() => validatePayloadName(bad), bad);
  assert.throws(() => encodeTail({ payloadOffset: 1, payloadLen: 1, installBytes: 1, payloadSha256: Buffer.alloc(32), meta: { product: 'S', version: '1', payloadName: '..\\x', builtAt: 't' } }));
});

test('SHA256SUMS.txt и manifest.json: чужие записи и поля сохраняются', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egoist-social-merge-'));
  try {
    const sums = path.join(dir, 'SHA256SUMS.txt');
    await writeFile(sums, `${'a'.repeat(64)} *Old Raw Setup.exe
${'b'.repeat(64)} *Egoist-Social-Setup-1.7.1.exe
`);
    await mergeSums(sums, 'Egoist-Social-Setup-1.7.1.exe', 'c'.repeat(64));
    assert.equal(await readFile(sums, 'utf8'), `${'a'.repeat(64)} *Old Raw Setup.exe
${'c'.repeat(64)} *Egoist-Social-Setup-1.7.1.exe
`);
    await mergeSums(sums, 'Other.exe', 'd'.repeat(64));
    assert.equal((await readFile(sums, 'utf8')).trim().split('\n').length, 3);
    const manifest = path.join(dir, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, package: 'NSIS', installer: { fileName: 'raw.exe' }, executable: { fileName: 'Egoist Relay.exe' } }));
    await mergeManifest(manifest, { fileName: 'Egoist-Social-Setup-1.7.1.exe' });
    const m = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(m.schemaVersion, 1);
    assert.equal(m.installer.fileName, 'raw.exe');
    assert.equal(m.executable.fileName, 'Egoist Relay.exe');
    assert.equal(m.sfx.fileName, 'Egoist-Social-Setup-1.7.1.exe');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('сборка атомарна: неудачная проверка не оставляет ни .part, ни итогового файла', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egoist-social-atomic-'));
  try {
    const stub = path.join(dir, 'stub.exe');
    const payload = path.join(dir, 'payload.bin');
    await writeFile(stub, Buffer.from('not a real executable'));
    await writeFile(payload, Buffer.alloc(1000, 7));
    await assert.rejects(buildInstaller({ stub, payload, outDir: dir, version: '1.7.1', installBytes: 1 }), /--verify/);
    assert.equal(existsSync(path.join(dir, 'Egoist-Social-Setup-1.7.1.exe.part')), false);
    assert.equal(existsSync(path.join(dir, 'Egoist-Social-Setup-1.7.1.exe')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('хвост: размеры, сигнатуры и контрольная сумма', () => {
  const sha = createHash('sha256').update('x').digest();
  const tail = encodeTail({ payloadOffset: 10, payloadLen: 1, installBytes: 5, payloadSha256: sha, meta: { product: 'Egoist Social', version: '1.7.1', payloadName: 'p.exe', builtAt: 'now' } });
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
    const dir = await mkdtemp(path.join(os.tmpdir(), 'egoist-social-sfx-'));
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

const sampleProvisioning = () => ({
  schema: 1,
  vpn: 'vless://00000000-0000-0000-0000-000000000000@vpn.example.invalid:443?type=tcp&security=reality#fixture',
  doh: 'https://doh.example.invalid/dns-query',
  mtproxy: '',
});

test('provisioning: проверка формата, сводка без значений', () => {
  const ok = validateProvisioning(sampleProvisioning());
  assert.equal(ok.schema, 1);
  assert.match(describeProvisioning(ok), /^provisioning: да, vpn: ссылок 1, doh: да, mtproxy: нет$/);
  const many = validateProvisioning({ ...sampleProvisioning(), vpn: 'vless://a@h1.example.invalid:1\r\ntrojan://b@h2.example.invalid:2\n', mtproxy: 'tg://proxy?server=x.example.invalid&port=1&secret=dd00112233445566778899aabbccddeeff' });
  assert.match(describeProvisioning(many), /vpn: ссылок 2, doh: да, mtproxy: да/);
  const sub = validateProvisioning({ ...sampleProvisioning(), vpn: 'https://sub.example.invalid/token-fixture' });
  assert.match(describeProvisioning(sub), /vpn: подписка/);
  assert.match(describeProvisioning(null), /нет/);
  for (const doh of ['https://dns.nextdns.io/abc123', 'https://dns.controld.com/xyz', 'https://doh.example.invalid', 'https://doh.example.invalid:8443/q?k=v']) {
    assert.equal(validateProvisioning({ ...sampleProvisioning(), doh }).doh, doh);
  }
  const text = [describeProvisioning(ok), describeProvisioning(many), describeProvisioning(sub)].join('\n');
  assert.ok(!/example\.invalid|vless:|token-fixture/.test(text), 'сводка не должна содержать значения');
  const bad = [
    null, [], { ...sampleProvisioning(), schema: 2 }, { ...sampleProvisioning(), vpn: '' }, { ...sampleProvisioning(), vpn: 'не ссылка' },
    { ...sampleProvisioning(), vpn: 'https://s.example.invalid/a\nvless://x@h:1' },
    { ...sampleProvisioning(), doh: 'http://doh.example.invalid/dns-query' }, { ...sampleProvisioning(), doh: 'https://user:pw@doh.example.invalid/x' },
    { ...sampleProvisioning(), doh: 'https://doh.example.invalid/a b' },
    { ...sampleProvisioning(), doh: '' }, { ...sampleProvisioning(), mtproxy: 'socks5://x.example.invalid:1' }, { ...sampleProvisioning(), mtproxy: 5 },
    { ...sampleProvisioning(), mtproxy: 'tg://proxy?server=x.example.invalid&port=1&secret=ee00112233445566778899aabbccddeeff6578616d706c65' },
    { ...sampleProvisioning(), mtproxy: 'https://t.me/proxy?server=x.example.invalid&port=1&secret=7gARIjNEVWZ3iJmqu8zd7_9leGFtcGxl' },
  ];
  for (const value of bad) {
    assert.throws(() => validateProvisioning(value), (e) => /^provisioning:/.test(e.message) && !/example\.invalid|vless:/.test(e.message), JSON.stringify(value));
  }
});

test('provisioning: файл читается, отсутствие файла — null, битый JSON не раскрывает содержимое', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egoist-social-prov-'));
  try {
    assert.equal(await loadProvisioning(path.join(dir, 'нет.json')), null);
    const file = path.join(dir, 'provisioning.local.json');
    await writeFile(file, `\uFEFF${JSON.stringify(sampleProvisioning())}`);
    assert.equal((await loadProvisioning(file)).doh, 'https://doh.example.invalid/dns-query');
    await writeFile(file, '{"schema":1,"vpn":"vless://секрет-фикстуры');
    await assert.rejects(loadProvisioning(file), (e) => /не разобран/.test(e.message) && !e.message.includes('секрет-фикстуры'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('хвост: provisioning попадает в meta, без него поля нет; контрольная сумма покрывает meta', () => {
  const sha = createHash('sha256').update('x').digest();
  const meta = { product: 'Egoist Social', version: '1.9.0', payloadName: 'p.exe', builtAt: 'now' };
  const without = encodeTail({ payloadOffset: 10, payloadLen: 1, installBytes: 5, payloadSha256: sha, meta });
  assert.ok(!without.subarray(0, without.length - 128).toString().includes('provisioning'));
  const prov = validateProvisioning(sampleProvisioning());
  const withProv = encodeTail({ payloadOffset: 10, payloadLen: 1, installBytes: 5, payloadSha256: sha, meta: { ...meta, provisioning: prov } });
  const t = withProv.subarray(withProv.length - 128);
  const metaBytes = withProv.subarray(0, withProv.length - 128);
  assert.deepEqual(JSON.parse(metaBytes.toString()).provisioning, prov);
  assert.equal(t.readUInt32LE(40), metaBytes.length);
  assert.deepEqual(t.subarray(80, 112), createHash('sha256').update(metaBytes).update(t.subarray(0, 80)).digest());
});

test('сборка с provisioning: Rust --verify принимает файл, provisioning лежит в хвосте',
  { skip: process.platform !== 'win32' || !existsSync(realStub) }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'egoist-social-prov-sfx-'));
    try {
      const payload = path.join(dir, 'payload.bin');
      await writeFile(payload, Buffer.alloc(5000, 3));
      const r = await buildInstaller({ stub: realStub, payload, outDir: dir, version: '1.9.0', installBytes: 1, provisioning: sampleProvisioning() });
      const bytes = await readFile(r.outFile);
      assert.ok(bytes.subarray(bytes.length - 2000).includes(Buffer.from('doh.example.invalid')));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
