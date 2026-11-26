// Выпуск обновления Бересты: манифест + подпись + публикация полного релиза GitHub.
//
//   node scripts/release-update.mjs --version 1.10.3 [--dry-run] [--notes-file notes.md] [--key <путь>] [--min-version 1.9.0]
//
// Берёт release/<версия>/Beresta-Setup-<версия>.exe, пишет release/<версия>/update/{manifest.json,
// manifest.json.sig, SHA256SUMS.txt} (отдельная папка: build-installer.mjs держит в release/<версия>/ свои
// manifest.json и SHA256SUMS.txt другого формата), подписывает через tools/beresta-sign и, без --dry-run,
// создаёт релиз v<версия> в egoist-ai1/beresta-releases (полный, не prerelease: иначе releases/latest его не вернёт).
// Ключ и токены не печатаются; авторизацию gh берёт у самого gh.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractPubkeys, requireCondition, sha256 } from './release-policy.mjs';

export const REPO = 'egoist-ai1/beresta-releases';
export const SEMVER = /^\d+\.\d+\.\d+$/;
export const ASSET_NAMES = ['manifest.json', 'manifest.json.sig', 'SHA256SUMS.txt'];
/** Границы размера установщика: те же, что в приложении (tauri/src/update/manifest.rs, SizeBounds::PRODUCTION). */
export const INSTALLER_BOUNDS = { min: 100 * 1024 * 1024, max: 1024 * 1024 * 1024 };

export function checkInstallerSize(size, bounds = INSTALLER_BOUNDS) {
  requireCondition(size >= bounds.min && size <= bounds.max,
    `Размер установщика ${size} байт вне допустимых границ ${bounds.min}…${bounds.max}: приложение отклонит такое обновление`);
}

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function installerName(version) {
  return `Beresta-Setup-${version}.exe`;
}

export function defaultKeyPath(env = process.env) {
  const base = env.LOCALAPPDATA || (env.USERPROFILE && path.join(env.USERPROFILE, 'AppData', 'Local'));
  requireCondition(base, 'Не задан LOCALAPPDATA: укажите ключ через --key');
  return path.join(base, 'Egoist', 'sign', 'beresta-update.key');
}

export function parseArgs(argv) {
  const out = { dryRun: false };
  const takes = { '--version': 'version', '--notes-file': 'notesFile', '--key': 'key', '--min-version': 'minVersion' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (takes[arg]) {
      requireCondition(i + 1 < argv.length && !argv[i + 1].startsWith('--'), `${arg} требует значение`);
      out[takes[arg]] = argv[i += 1];
    } else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  requireCondition(out.version, 'Нужен --version X.Y.Z');
  requireCondition(SEMVER.test(out.version), `Версия не semver X.Y.Z: ${out.version}`);
  requireCondition(!out.minVersion || SEMVER.test(out.minVersion), `min-version не semver X.Y.Z: ${out.minVersion}`);
  return out;
}

/** Манифест строго с полями v, product, arch, version, published, installer{name,size,sha256}, notes (+min_version). */
export function buildManifest({ version, installer, notes = '', minVersion, now = new Date(), bounds = INSTALLER_BOUNDS }) {
  requireCondition(SEMVER.test(version), `Версия не semver X.Y.Z: ${version}`);
  requireCondition(installer && installer.name === installerName(version) && Number.isSafeInteger(installer.size)
    && installer.size > 0 && /^[a-f0-9]{64}$/.test(installer.sha256), 'Некорректные данные установщика');
  checkInstallerSize(installer.size, bounds);
  const manifest = {
    v: 1, product: 'Beresta', arch: 'x64', version,
    published: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    installer: { name: installer.name, size: installer.size, sha256: installer.sha256 },
    notes: String(notes ?? ''),
  };
  if (minVersion) {
    requireCondition(SEMVER.test(minVersion), `min-version не semver X.Y.Z: ${minVersion}`);
    manifest.min_version = minVersion;
  }
  return manifest;
}

/** Подписываются ТОЧНЫЕ байты этой строки/файла: сериализуем один раз. */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function sumsText(entries) {
  return entries.map(({ sha256: hex, name }) => `${hex} *${name}`).join('\n') + '\n';
}

export function defaultRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error };
}

function signerArgs(root, rest) {
  return ['run', '--offline', '--quiet', '--manifest-path', path.join(root, 'tools', 'beresta-sign', 'Cargo.toml'), '--', ...rest];
}

function must(result, what) {
  // stderr подписывающей программы не содержит секретов (она их не печатает), но выводим только первую строку.
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').split('\n')[0].slice(0, 300);
    throw new Error(`${what}: ${detail || `код ${result.status}`}`);
  }
  return result;
}

export async function readNotes(file) {
  if (!file) return '';
  return (await readFile(file, 'utf8')).replace(/\r\n/g, '\n').trim();
}

export async function loadPubkeyHex(root) {
  const text = await readFile(path.join(root, 'tauri', 'src', 'update', 'pubkeys.rs'), 'utf8');
  requireCondition(!/PLACEHOLDER/i.test(text), 'tauri/src/update/pubkeys.rs содержит заглушку PLACEHOLDER');
  const keys = extractPubkeys(text);
  requireCondition(keys.length > 0, 'В tauri/src/update/pubkeys.rs не найден открытый ключ [u8; 32]');
  requireCondition(keys.every((key) => key.some((byte) => byte !== 0)), 'В pubkeys.rs нулевой ключ-заглушка');
  return Buffer.from(keys[0]).toString('hex');
}

/**
 * Выпуск. Зависимости внедряются (runner, now, log), чтобы тесты не вызывали gh и cargo.
 * При dryRun ничего не пишется и не публикуется.
 */
export async function runRelease(options, deps = {}) {
  const { root = rootDefault, env = process.env, runner = defaultRunner, now = new Date(), log = () => {}, bounds = INSTALLER_BOUNDS } = deps;
  const { version, dryRun = false } = options;
  requireCondition(SEMVER.test(version || ''), `Версия не semver X.Y.Z: ${version}`);

  const releaseDir = path.join(root, 'release', version);
  const exe = path.join(releaseDir, installerName(version));
  let info;
  try { info = await stat(exe); } catch { throw new Error(`Не найден установщик: ${exe}`); }
  requireCondition(info.isFile() && info.size > 0, `Установщик пуст или не файл: ${exe}`);

  const keyPath = options.key || defaultKeyPath(env);
  requireCondition(existsSync(keyPath), `Приватный ключ подписи не найден: ${keyPath}. Создайте его: beresta-sign keygen --out <путь>, либо укажите --key`);
  checkInstallerSize(info.size, bounds);

  const installer = { name: installerName(version), size: info.size, sha256: await sha256(exe) };
  const manifest = buildManifest({ version, installer, notes: await readNotes(options.notesFile), minVersion: options.minVersion, now, bounds });
  const text = serializeManifest(manifest);
  const outDir = path.join(releaseDir, 'update');
  const files = { manifest: path.join(outDir, 'manifest.json'), sig: path.join(outDir, 'manifest.json.sig'), sums: path.join(outDir, 'SHA256SUMS.txt') };

  log(`Установщик: ${installer.name}, ${installer.size} байт, sha256 ${installer.sha256}`);
  log(`Манифест: версия ${version}, published ${manifest.published}`);
  if (dryRun) {
    log('DRY-RUN: ничего не записывается и не публикуется. Было бы сделано:');
    log(`  1. записать ${files.manifest}`);
    log(`  2. подписать (beresta-sign, ключ ${keyPath}) -> ${files.sig}`);
    log(`  3. записать ${files.sums}`);
    log(`  4. gh release create v${version} --repo ${REPO} (полный релиз, не prerelease) с ассетами: ${installer.name}, ${ASSET_NAMES.join(', ')}`);
    log('  5. скачать манифест из релиза и проверить подпись ключом из tauri/src/update/pubkeys.rs');
    return { dryRun: true, manifest, text, files };
  }

  const pubkeyHex = await loadPubkeyHex(root);
  await mkdir(outDir, { recursive: true });
  await writeFile(files.manifest, text);
  must(runner('cargo', signerArgs(root, ['sign', '--key', keyPath, '--in', files.manifest, '--out', files.sig]), { cwd: root }), 'Подпись не удалась');
  // Проверяем ДО публикации: ключ подписи должен соответствовать ключу, вшитому в приложение.
  must(runner('cargo', signerArgs(root, ['verify', '--pubkey-hex', pubkeyHex, '--in', files.manifest, '--sig', files.sig]), { cwd: root }),
    'Подпись не проходит ключом из pubkeys.rs (ключ подписи не тот, что вшит в приложение)');
  await writeFile(files.sums, sumsText([
    { name: installer.name, sha256: installer.sha256 },
    { name: 'manifest.json', sha256: await sha256(files.manifest) },
    { name: 'manifest.json.sig', sha256: await sha256(files.sig) },
  ]));
  log('Подписано и проверено ключом из pubkeys.rs');

  const notesArgs = options.notesFile ? ['--notes-file', options.notesFile] : ['--notes', `Береста ${version}`];
  must(runner('gh', ['release', 'create', `v${version}`, exe, files.manifest, files.sig, files.sums,
    '--repo', REPO, '--title', `v${version}`, '--latest', ...notesArgs], { cwd: root }), 'gh release create');
  log(`Релиз v${version} опубликован в ${REPO}`);

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'beresta-verify-'));
  try {
    must(runner('gh', ['release', 'download', `v${version}`, '--repo', REPO, '--pattern', 'manifest.json',
      '--pattern', 'manifest.json.sig', '--dir', tmp, '--clobber'], { cwd: root }), 'Скачивание манифеста');
    must(runner('cargo', signerArgs(root, ['verify', '--pubkey-hex', pubkeyHex, '--in', path.join(tmp, 'manifest.json'),
      '--sig', path.join(tmp, 'manifest.json.sig')]), { cwd: root }), 'Опубликованный манифест не прошёл проверку подписи');
    log('Опубликованный манифест скачан и проверен');
  } finally { await rm(tmp, { recursive: true, force: true }); }
  return { dryRun: false, manifest, text, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runRelease(parseArgs(process.argv.slice(2)), { log: (line) => process.stdout.write(`${line}\n`) });
  } catch (error) {
    process.stderr.write(`Выпуск обновления не выполнен: ${error.message}\n`);
    process.exitCode = 1;
  }
}
