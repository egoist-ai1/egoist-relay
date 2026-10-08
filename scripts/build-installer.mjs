// Сборка фирменного установщика: installer/target/release/Sennit-Setup.exe + NSIS-установщик Tauri (payload) + хвост.
// Формат хвоста описан в installer/src/tail.rs. Файлы пишутся потоково, 540 МБ в память не грузятся.
//
// Порядок для подписанного выпуска: собрать этим скриптом, затем подписать ГОТОВЫЙ файл (signtool).
// Authenticode хэширует и наложение (хвост), поэтому подпись после сборки валидна, а сам установщик
// при чтении хвоста отбрасывает сертификат в конце файла (см. effective_len в tail.rs).
// После подписи SHA256SUMS.txt и manifest.json нужно пересчитать (`--rehash`).
//
// Обычный запуск (после `npm run tauri:build` и `cargo build --release` в installer/):
//   node scripts/build-installer.mjs
// Явные пути (проверки, нестандартная сборка):
//   node scripts/build-installer.mjs --stub <exe> --payload <nsis.exe> --out <dir> [--version 1.7.1] [--install-bytes N] [--no-verify]
// Пересчёт хэшей уже собранного (например, подписанного) файла:
//   node scripts/build-installer.mjs --rehash [--out <dir>] [--version 1.7.1]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAGIC = Buffer.from('SENNITSX');
const END_MAGIC = Buffer.from('XSTINNES');
const TRAILER_LEN = 128;
const FORMAT_VERSION = 1;
const MAX_META_LEN = 64 * 1024;

/** Те же правила, что в installer/src/tail.rs: имя попадает в путь распаковки. */
export function validatePayloadName(name) {
  if (typeof name !== 'string' || !name || name.length > 80 || name.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Недопустимое payloadName: ${JSON.stringify(name)} (разрешено [A-Za-z0-9._-], до 80 знаков, не с точки)`);
  }
}

export function encodeTail({ payloadOffset, payloadLen, installBytes, payloadSha256, meta }) {
  validatePayloadName(meta.payloadName);
  const metaBytes = Buffer.from(JSON.stringify(meta), 'utf8');
  if (metaBytes.length > MAX_META_LEN) throw new Error('meta слишком большая');
  const t = Buffer.alloc(TRAILER_LEN);
  MAGIC.copy(t, 0);
  t.writeUInt32LE(FORMAT_VERSION, 8);
  t.writeBigUInt64LE(BigInt(payloadOffset), 16);
  t.writeBigUInt64LE(BigInt(payloadLen), 24);
  t.writeBigUInt64LE(BigInt(installBytes), 32);
  t.writeUInt32LE(metaBytes.length, 40);
  payloadSha256.copy(t, 48);
  createHash('sha256').update(metaBytes).update(t.subarray(0, 80)).digest().copy(t, 80);
  END_MAGIC.copy(t, 120);
  return Buffer.concat([metaBytes, t]);
}

async function sha256File(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest();
}

/** Ожидаемый размер установленного каталога: exe + ресурсы из tauri.conf.json + запас на uninstall.exe. */
export async function expectedInstallBytes() {
  const config = JSON.parse(await readFile(path.join(root, 'tauri/tauri.conf.json'), 'utf8'));
  let total = 0;
  const exe = path.join(root, 'tauri/target/release', `${config.mainBinaryName}.exe`);
  total += (await stat(exe)).size;
  for (const source of Object.keys(config.bundle.resources ?? {})) {
    const file = path.resolve(path.join(root, 'tauri'), source);
    try { total += (await stat(file)).size; } catch { throw new Error(`Нет ресурса для оценки размера: ${source}`); }
  }
  return total + 1024 * 1024;
}

async function findPayload(version) {
  const dir = path.join(root, 'tauri/target/release/bundle/nsis');
  const names = (await readdir(dir)).filter((n) => n.endsWith('_x64-setup.exe') && n.includes(`_${version}_`));
  if (names.length !== 1) throw new Error(`В ${dir} ожидается один *_${version}_x64-setup.exe, найдено: ${names.length}`);
  return path.join(dir, names[0]);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

/** Запускает собранный файл с --verify; GUI-exe без консоли, результат — код выхода. */
export function verifyBuilt(file) {
  if (process.platform !== 'win32') return;
  const r = spawnSync(file, ['--verify'], { windowsHide: true, timeout: 120000 });
  if (r.status !== 0) throw new Error(`Собранный файл не прошёл --verify (код ${r.status ?? r.signal})`);
}

export async function buildInstaller({ stub, payload, outDir, version, installBytes, verify = true }) {
  const stubStat = await stat(stub);
  const payloadStat = await stat(payload);
  if (!stubStat.size || !payloadStat.size) throw new Error('Пустой stub или payload');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `Sennit-Setup-${version}.exe`);
  const part = `${outFile}.part`;
  const payloadSha256 = await sha256File(payload);
  const tail = encodeTail({
    payloadOffset: stubStat.size,
    payloadLen: payloadStat.size,
    installBytes,
    payloadSha256,
    meta: { product: 'Sennit', version, payloadName: `Sennit-Payload-${version}.exe`, builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
  });
  try {
    const out = createWriteStream(part);
    const failed = new Promise((_, rej) => out.once('error', rej));
    const write = (chunk) => Promise.race([failed, new Promise((res, rej) => out.write(chunk, (e) => (e ? rej(e) : res())))]);
    for (const file of [stub, payload]) {
      for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) await write(chunk);
    }
    await write(tail);
    await Promise.race([failed, new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())))]);
    const size = (await stat(part)).size;
    if (size !== stubStat.size + payloadStat.size + tail.length) throw new Error('Размер собранного файла не совпал с ожидаемым');
    if (verify) verifyBuilt(part);
    await rename(part, outFile);
  } catch (error) {
    await unlink(part).catch(() => {});
    throw error;
  }
  const size = (await stat(outFile)).size;
  const outSha256 = (await sha256File(outFile)).toString('hex');
  return { outFile, size, outSha256, payloadSha256: payloadSha256.toString('hex'), payloadBytes: payloadStat.size, stubBytes: stubStat.size, installBytes };
}

/** SHA256SUMS.txt: заменить/добавить строку по имени файла, остальные строки сохранить как есть. */
export async function mergeSums(file, name, hex) {
  let lines = [];
  try { lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const entry = `${hex} *${name}`;
  const kept = lines.filter((l) => l.replace(/^[0-9a-fA-F]+\s+\*?/, '') !== name);
  const index = lines.findIndex((l) => l.replace(/^[0-9a-fA-F]+\s+\*?/, '') === name);
  if (index === -1) kept.push(entry); else kept.splice(Math.min(index, kept.length), 0, entry);
  await writeFile(file, `${kept.join('\n')}\n`);
}

/** manifest.json: сохранить все существующие поля (installer, executable, limitations…), обновить секцию sfx. */
export async function mergeManifest(file, sfx) {
  let manifest = {};
  try { manifest = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (manifest.schemaVersion === undefined) manifest.schemaVersion = 1;
  manifest.sfx = sfx;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = arg('version') ?? pkg.version;
  const outDir = arg('out') ?? path.join(root, 'release', version);
  const name = `Sennit-Setup-${version}.exe`;
  if (flag('rehash')) {
    const file = path.join(outDir, name);
    const hex = (await sha256File(file)).toString('hex');
    await mergeSums(path.join(outDir, 'SHA256SUMS.txt'), name, hex);
    let manifest = {};
    try { manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8')); } catch { /* нет манифеста */ }
    await mergeManifest(path.join(outDir, 'manifest.json'), { ...(manifest.sfx ?? {}), fileName: name, sha256: hex, bytes: (await stat(file)).size });
    process.stdout.write(`${name}: SHA-256 ${hex} (пересчитан)\n`);
    return;
  }
  const stub = arg('stub') ?? path.join(root, 'installer/target/release/Sennit-Setup.exe');
  const payload = arg('payload') ?? await findPayload(version);
  const installBytes = Number(arg('install-bytes') ?? await expectedInstallBytes());
  const r = await buildInstaller({ stub, payload, outDir, version, installBytes, verify: !flag('no-verify') });
  await mergeSums(path.join(outDir, 'SHA256SUMS.txt'), name, r.outSha256);
  await mergeManifest(path.join(outDir, 'manifest.json'), {
    fileName: name,
    sha256: r.outSha256,
    bytes: r.size,
    version,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    authenticode: 'NotSigned',
    installed: false,
    stubBytes: r.stubBytes,
    payload: { name: path.basename(payload), sha256: r.payloadSha256, bytes: r.payloadBytes, expectedInstallBytes: r.installBytes },
  });
  process.stdout.write(`${name}: ${r.size} bytes, SHA-256 ${r.outSha256}\npayload ${r.payloadBytes} bytes, SHA-256 ${r.payloadSha256}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`build-installer: ${e.message}\n`); process.exitCode = 1; });
}
