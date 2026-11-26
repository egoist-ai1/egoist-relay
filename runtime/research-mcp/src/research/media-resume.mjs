// Возобновление и приём больших медиафайлов (этап 2). Чистая логика и файловые помощники без обращения к мосту:
// выравнивание смещения по 1 МиБ, выбор .part, пересчёт SHA-256 по префиксу, приём готового файла из spool Relay.
// Файл, чьи байты не прошли проверку размера и SHA-256, не получает конечного имени.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { assertSafeDirectory, assertSafeFile } from './job-store.mjs';

export const MEDIA_ALIGN_BYTES = 1048576;
const KEY = /^[a-f0-9]{32}$/;
const SPOOL_NAME = /^([a-f0-9]{32})\.([a-f0-9]{16})\.(part|done)$/;
const PART_META_BYTES = 4096;

export class MediaResumeError extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; Object.assign(this, extra); }
}
const fail = code => new MediaResumeError(code);

/** Ключ файла: 32 hex-символа от платформы и канонической ссылки; один и тот же источник даёт один и тот же ключ. */
export function mediaKeyFor(provider, url) { return createHash('sha256').update(`${provider}|${url}`).digest('hex').slice(0, 32); }
export const isMediaKey = value => typeof value === 'string' && KEY.test(value);
/** Смещение возобновления: наибольшее кратное 1 МиБ, не больше уже принятого. */
export const alignDown = size => (Number.isSafeInteger(size) && size > 0 ? Math.floor(size / MEDIA_ALIGN_BYTES) * MEDIA_ALIGN_BYTES : 0);

async function hashPrefix(handle, length, hash) {
  const buffer = Buffer.allocUnsafe(Math.min(length, MEDIA_ALIGN_BYTES) || 1);
  let position = 0;
  while (position < length) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position);
    if (!bytesRead) throw fail('RESUME_MISMATCH');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

async function readMeta(metaPath) {
  const stat = await assertSafeFile(metaPath, { optional: true });
  if (!stat || stat.size > PART_META_BYTES) return undefined;
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    return Number.isSafeInteger(meta?.declaredBytes) && meta.declaredBytes > 0 ? meta : undefined;
  } catch { return undefined; }
}

const pathsOf = (partsDir, key) => ({ partPath: path.join(partsDir, `${key}.part`), metaPath: path.join(partsDir, `${key}.json`) });

/** Смещение, с которого можно продолжить скачивание: размер .part, выровненный вниз. Нет метаданных или файла — 0. */
export async function findResumeOffset({ partsDir, key }) {
  if (!isMediaKey(key)) throw fail('INVALID_MEDIA_KEY');
  await assertSafeDirectory(partsDir, { create: true });
  const { partPath, metaPath } = pathsOf(partsDir, key);
  const [part, meta] = await Promise.all([assertSafeFile(partPath, { optional: true }), readMeta(metaPath)]);
  if (!part || !meta) return { offset: 0, declaredBytes: undefined };
  return { offset: alignDown(Math.min(part.size, meta.declaredBytes)), declaredBytes: meta.declaredBytes };
}

/**
 * Открывает .part для записи. resumeFrom = 0 — файл начинается заново. Иначе .part обязан быть не короче resumeFrom и принадлежать файлу
 * того же размера: хвост за точкой возобновления отрезается, префикс заново хэшируется, запись идёт с точки возобновления.
 * Возвращает { handle, hash, size, partPath }; hash уже содержит байты префикса.
 */
export async function openResumablePart({ partsDir, key, declaredBytes, resumeFrom, mimeType, sourceUrl }) {
  if (!isMediaKey(key) || !Number.isSafeInteger(declaredBytes) || declaredBytes < 1) throw fail('INVALID_MEDIA_KEY');
  if (!Number.isSafeInteger(resumeFrom) || resumeFrom < 0 || resumeFrom % MEDIA_ALIGN_BYTES !== 0 || resumeFrom >= declaredBytes) throw fail('RESUME_MISMATCH');
  await assertSafeDirectory(partsDir, { create: true });
  const { partPath, metaPath } = pathsOf(partsDir, key);
  const hash = createHash('sha256');
  if (resumeFrom === 0) {
    await fs.rm(metaPath, { force: true });
    const handle = await fs.open(partPath, 'w', 0o600);
    await fs.writeFile(metaPath, JSON.stringify({ declaredBytes, mimeType, sourceUrl }), { mode: 0o600 });
    return { handle, hash, size: 0, partPath };
  }
  const [part, meta] = await Promise.all([assertSafeFile(partPath, { optional: true }), readMeta(metaPath)]);
  if (!part || !meta || meta.declaredBytes !== declaredBytes || part.size < resumeFrom) throw fail('RESUME_MISMATCH');
  const handle = await fs.open(partPath, 'r+');
  try {
    await handle.truncate(resumeFrom);
    await hashPrefix(handle, resumeFrom, hash);
  } catch (error) { await handle.close(); throw error; }
  return { handle, hash, size: resumeFrom, partPath };
}

/** Удаляет .part и метаданные ключа (после успешного переноса или при несовпадении). */
export async function discardParts({ partsDir, key }) {
  if (!isMediaKey(key)) throw fail('INVALID_MEDIA_KEY');
  const { partPath, metaPath } = pathsOf(partsDir, key);
  await Promise.all([fs.rm(partPath, { force: true }), fs.rm(metaPath, { force: true })]);
}

// ---------- spool Relay: <stateRoot>/spool/<key>.<fingerprint>.(part|done) ----------

async function spoolFilesOf(spoolDir, key) {
  let names;
  try { names = await fs.readdir(spoolDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => { const match = SPOOL_NAME.exec(name); return match && match[1] === key; });
}

/**
 * Смещение возобновления для spool: единственный .part ключа, размер выровнен вниз. Несколько версий файла или остаток .done
 * от прошлого запуска — спорный случай: они удаляются, скачивание начинается с нуля.
 */
export async function findSpoolResume({ spoolDir, key }) {
  if (!isMediaKey(key)) throw fail('INVALID_MEDIA_KEY');
  const files = await spoolFilesOf(spoolDir, key);
  const parts = files.filter(name => name.endsWith('.part'));
  if (files.length !== 1 || parts.length !== 1) {
    await discardSpool({ spoolDir, key });
    return { offset: 0 };
  }
  const stat = await assertSafeFile(path.join(spoolDir, parts[0]), { optional: true });
  return { offset: stat ? alignDown(stat.size) : 0 };
}

export async function discardSpool({ spoolDir, key }) {
  if (!isMediaKey(key)) throw fail('INVALID_MEDIA_KEY');
  for (const name of await spoolFilesOf(spoolDir, key)) await fs.rm(path.join(spoolDir, name), { force: true });
}

async function sha256Of(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: MEDIA_ALIGN_BYTES })) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Принимает готовый файл spool: имя и ключ проверены, файл обычный, одна ссылка, размер совпал, SHA-256 совпал с объявленным Relay.
 * Затем файл переносится в target (rename; при другом томе — копия с fsync и удаление источника). Проверенный хэш возвращается.
 * Ошибки: SPOOL_FILE_INVALID (имя, тип, размер), SPOOL_HASH_MISMATCH (файл остаётся в spool для разбора), DISK_RESERVE (копия не помещается).
 */
export async function promoteSpoolFile({ spoolDir, key, spool, expectedBytes, target, diskFree, reserve = 0 }) {
  const match = SPOOL_NAME.exec(spool?.name ?? '');
  if (!match || match[1] !== key || match[3] !== 'done' || !Number.isSafeInteger(spool.bytes) || spool.bytes !== expectedBytes || !/^[a-f0-9]{64}$/.test(spool.sha256 ?? '')) throw fail('SPOOL_FILE_INVALID');
  const source = path.join(spoolDir, spool.name);
  let stat;
  try { stat = await assertSafeFile(source); } catch { throw fail('SPOOL_FILE_INVALID'); }
  if (stat.size !== expectedBytes) throw fail('SPOOL_FILE_INVALID');
  const actual = await sha256Of(source);
  if (actual !== spool.sha256) throw fail('SPOOL_HASH_MISMATCH');
  try { await fs.rename(source, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    if (diskFree && await diskFree(path.dirname(target)) < reserve + expectedBytes) throw fail('DISK_RESERVE');
    const input = await fs.open(source, 'r');
    const output = await fs.open(target, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(MEDIA_ALIGN_BYTES);
      for (;;) { const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break; await output.write(buffer, 0, bytesRead); }
      await output.sync();
    } finally { await input.close(); await output.close(); }
    if (await sha256Of(target) !== actual) { await fs.rm(target, { force: true }); throw fail('SPOOL_HASH_MISMATCH'); }
    await fs.unlink(source);
  }
  return { sha256: actual, bytes: expectedBytes };
}
