// Помощник: собирает provisioning.local.json из установленного Egoist Lagom (только чтение).
//
// Формат хранения взят из исходников Lagom, а не из реальных файлов:
//   v2: %ProgramData%\EgoLag\Core\profile.json (activeNodeId, nodes[].uri, subscriptions[].url, settings.customDnsUrl)
//       и Core\desired.json (dns.dohUrl) — v2/src/Contracts/LagomPaths.cs, VpnSchemas.cs, Schemas.cs;
//   v1: %APPDATA%\Egoist Shield\egoistshield-state.json (activeNodeId, nodes[].uri, subscriptions[].url,
//       settings.customDnsUrl / systemDohUrl) — src/recovered/electron/ipc/state-store.js.
//
// Использование:
//   node scripts/provisioning-from-lagom.mjs [--dry-run] [--force] [--subscription] [--source v1|v2]
//        [--max-nodes N] [--doh <url>] [--mtproxy <ссылка>] [--out <файл>]
// Значения (ссылки, URL, ключи) никогда не печатаются: только сводка.
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVISIONING_FILE, describeProvisioning, validateProvisioning } from './build-installer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Схемы, которые умеет Xray и разбирает ядро приложения (hy2, tuic, wireguard пропускаются). */
const XRAY_URI = /^(?:vless|vmess|trojan|ss):\/\/\S+$/i;
const DEFAULT_MAX_NODES = 12;
/** Верхняя граница размера vpn: meta хвоста установщика ограничена 64 КБ. */
const MAX_VPN_CHARS = 40 * 1024;

export class ProvisioningError extends Error {}

/** Пути хранилищ Lagom по переменным окружения (подменяются в тестах). */
export function lagomLocations(env = process.env) {
  const programData = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
  const appData = env.APPDATA || '';
  return {
    v2: { profile: path.join(programData, 'EgoLag', 'Core', 'profile.json'), desired: path.join(programData, 'EgoLag', 'Core', 'desired.json') },
    v1: [appData && path.join(appData, 'Egoist Shield', 'egoistshield-state.json'), appData && path.join(appData, 'EgoistShield', 'egoistshield-state.json')].filter(Boolean),
  };
}

/** Читает JSON; нет файла — null; нет доступа или битый JSON — ProvisioningError без содержимого. */
async function readJson(file, label) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    if (e.code === 'EACCES' || e.code === 'EPERM') throw new ProvisioningError(`${label}: нет доступа на чтение (запустите от администратора)`);
    throw new ProvisioningError(`${label}: не удалось прочитать (${e.code ?? 'ошибка'})`);
  }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new ProvisioningError(`${label}: файл не разобран как JSON`); }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Выбор VPN из состояния (форма профиля v2 и состояния v1 совпадает по полям activeNodeId/nodes/subscriptions).
 * Активный узел идёт первым, затем остальные узлы его подписки; без подписки — один активный узел.
 * Если активного нет, берётся первый подходящий узел.
 */
export function pickVpn(state, { subscription = false, maxNodes = DEFAULT_MAX_NODES } = {}) {
  const nodes = Array.isArray(state?.nodes) ? state.nodes.filter(isObject) : [];
  const subs = Array.isArray(state?.subscriptions) ? state.subscriptions.filter(isObject) : [];
  const usable = (node) => XRAY_URI.test(str(node.uri));
  const active = nodes.find((node) => node.id === state?.activeNodeId && usable(node)) ?? nodes.find(usable);
  const owner = active?.subscriptionId ? subs.find((s) => s.id === active.subscriptionId) : undefined;
  if (subscription) {
    const sub = owner ?? (subs.filter((s) => s.enabled !== false && /^https?:\/\/\S+$/i.test(str(s.url))).length === 1
      ? subs.find((s) => s.enabled !== false && /^https?:\/\/\S+$/i.test(str(s.url))) : undefined);
    const url = str(sub?.url);
    if (!/^https?:\/\/\S+$/i.test(url)) throw new ProvisioningError('активная подписка не найдена: укажите ссылки узлов (без --subscription)');
    return url;
  }
  if (!active) throw new ProvisioningError('подходящих узлов (vless, vmess, trojan, ss) в Lagom не найдено');
  const chain = [active];
  if (active.subscriptionId) chain.push(...nodes.filter((node) => node !== active && node.subscriptionId === active.subscriptionId && usable(node)));
  const links = [...new Set(chain.slice(0, Math.max(1, maxNodes)).map((node) => str(node.uri)))];
  const joined = links.join('\n');
  if (joined.length > MAX_VPN_CHARS) throw new ProvisioningError('ссылки узлов не помещаются в установщик: уменьшите --max-nodes');
  return joined;
}

/** DoH из desired.json (v2) и настроек: первый подходящий https-адрес. */
export function pickDoh({ desired, state } = {}) {
  const candidates = [desired?.dns?.dohUrl, state?.settings?.customDnsUrl,
    state?.settings?.systemDohEnabled === true ? state?.settings?.systemDohUrl : undefined];
  return candidates.map(str).find((url) => /^https:\/\/\S+$/i.test(url)) ?? '';
}

/** Собирает объект provisioning из найденных данных; значения в сообщениях об ошибках не раскрываются. */
export function buildProvisioning({ state, desired }, options = {}) {
  const vpn = pickVpn(state, options);
  const doh = options.doh ?? pickDoh({ desired, state });
  if (!doh) throw new ProvisioningError('DoH не найден в Lagom: задайте --doh https://хост[/путь]');
  return validateProvisioning({ schema: 1, vpn, doh, mtproxy: options.mtproxy ?? '' });
}

/** Ищет установленный Lagom: сначала v2, затем v1. */
export async function discover(env = process.env, source) {
  const where = lagomLocations(env);
  if (source !== 'v1') {
    const state = await readJson(where.v2.profile, 'Lagom v2 profile.json');
    if (state) return { version: 'v2', state, desired: await readJson(where.v2.desired, 'Lagom v2 desired.json') };
    if (source === 'v2') throw new ProvisioningError('Lagom v2 не найден (Core\\profile.json)');
  }
  for (const file of where.v1) {
    const state = await readJson(file, 'Lagom v1 egoistshield-state.json');
    if (state) return { version: 'v1', state, desired: null };
  }
  throw new ProvisioningError('установленный Egoist Lagom не найден (ни v2, ни v1)');
}

export function parseArgs(argv) {
  const options = { dryRun: false, force: false, subscription: false, maxNodes: DEFAULT_MAX_NODES };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new ProvisioningError(`${arg}: нужно значение`); i += 1; return argv[i]; };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--subscription') options.subscription = true;
    else if (arg === '--source') { options.source = value(); if (!['v1', 'v2'].includes(options.source)) throw new ProvisioningError('--source: v1 или v2'); }
    else if (arg === '--max-nodes') { options.maxNodes = Number(value()); if (!Number.isInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > 50) throw new ProvisioningError('--max-nodes: целое от 1 до 50'); }
    else if (arg === '--doh') options.doh = value().trim();
    else if (arg === '--mtproxy') options.mtproxy = value().trim();
    else if (arg === '--out') options.out = value();
    else throw new ProvisioningError(`неизвестный параметр: ${arg}`);
  }
  return options;
}

/** Основной сценарий; возвращает строки сводки (без значений). Запись — только без --dry-run. */
export async function run(argv, env = process.env, outDefault = path.join(root, PROVISIONING_FILE)) {
  const options = parseArgs(argv);
  const found = await discover(env, options.source);
  const provisioning = buildProvisioning(found, options);
  const lines = [`источник: Lagom ${found.version}`, describeProvisioning(provisioning)];
  if (options.dryRun) return [...lines, 'dry-run: файл не записан'];
  const target = path.resolve(options.out ?? outDefault);
  let handle;
  try {
    handle = await open(target, options.force ? 'w' : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') throw new ProvisioningError(`${path.basename(target)} уже существует: файл не перезаписан (используйте --force)`);
    throw new ProvisioningError(`${path.basename(target)}: не удалось создать (${e.code ?? 'ошибка'})`);
  }
  try { await handle.writeFile(`${JSON.stringify(provisioning, null, 2)}\n`, 'utf8'); } finally { await handle.close(); }
  return [...lines, `записан: ${path.basename(target)}`];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((lines) => process.stdout.write(`${lines.join('\n')}\n`)).catch((e) => {
    process.stderr.write(`provisioning-from-lagom: ${e instanceof ProvisioningError ? e.message : 'непредвиденная ошибка'}\n`);
    process.exitCode = 1;
  });
}
