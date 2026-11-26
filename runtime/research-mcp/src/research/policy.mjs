// Политика владельца ~/.egoist-research/policy.json. Права проверяются здесь, в демоне; аннотации MCP — лишь подсказки.
// Файл создаётся с безопасными значениями, перечитывается при старте и меняется только владельцем (не инструментами).
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafeFile, assertSafeDirectory } from './job-store.mjs';
import { OrchError, isObject } from './orch-core.mjs';
import { canonicalJoinTarget } from './source-input.mjs';

const GOVERNOR_CLASS = (initial, min, max, dailyBudget) => ({ initialIntervalMs: initial, minIntervalMs: min, maxIntervalMs: max, ...(dailyBudget === undefined ? {} : { dailyBudget }) });

export const DEFAULT_POLICY = Object.freeze({
  schemaVersion: 1,
  // Чтение доступных аккаунту источников разрешено; всё остальное выключено.
  read: true,
  readPrivateThread: false,
  members: false,
  join: { enabled: false, allowedTargets: [], dailyLimit: 3 },
  confirm: { sources: 300, items: 1000000, mediaGiB: 20 },
  limits: { maxSourcesPerJob: 50000, maxActiveJobs: 8, sliceRecords: 200, planTtlMinutes: 120, telegramParallel: 2 },
  governor: {
    history: GOVERNOR_CLASS(1000, 250, 60000),
    resolve: GOVERNOR_CLASS(3000, 1000, 120000, 200),
    search: GOVERNOR_CLASS(5000, 2000, 300000, 100),
    growAfterMs: 600000, growFactor: 1.1, backoffFactor: 2, cooldownFactor: 1.1, longWaitSeconds: 900,
    breaker: { floodsPerHour: 3, openMs: 3600000 },
    providers: { x: { history: { initialIntervalMs: 5000, minIntervalMs: 2000, maxIntervalMs: 300000 } }, instagram: { history: { initialIntervalMs: 8000, minIntervalMs: 3000, maxIntervalMs: 600000 } } },
  },
  diskReserveGiB: 1,
});

const num = (value, min, max, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
  return value;
};
const bool = (value, name) => { if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`); return value; };
const only = (object, keys, name) => {
  if (!isObject(object)) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw new Error(`${name}.${key} is not supported`);
};

function governorClass(raw, base, name) {
  only(raw, ['initialIntervalMs', 'minIntervalMs', 'maxIntervalMs', 'dailyBudget'], name);
  const merged = { ...base, ...raw };
  num(merged.minIntervalMs, 10, 3600000, name + '.minIntervalMs');
  num(merged.initialIntervalMs, merged.minIntervalMs, 3600000, name + '.initialIntervalMs');
  num(merged.maxIntervalMs, merged.initialIntervalMs, 86400000, name + '.maxIntervalMs');
  if (merged.dailyBudget !== undefined) num(merged.dailyBudget, 0, 10000000, name + '.dailyBudget');
  return merged;
}

/** Строго проверяет файл и дополняет умолчаниями. Бросает Error с понятной причиной без значений. */
export function validatePolicy(raw) {
  only(raw, ['schemaVersion', 'read', 'readPrivateThread', 'members', 'join', 'confirm', 'limits', 'governor', 'diskReserveGiB'], 'policy');
  if (raw.schemaVersion !== 1) throw new Error('policy.schemaVersion must be 1');
  const base = structuredClone(DEFAULT_POLICY);
  const policy = structuredClone(base);
  for (const key of ['read', 'readPrivateThread', 'members']) if (raw[key] !== undefined) policy[key] = bool(raw[key], key);
  if (raw.join !== undefined) {
    only(raw.join, ['enabled', 'allowedTargets', 'dailyLimit'], 'join');
    if (raw.join.enabled !== undefined) policy.join.enabled = bool(raw.join.enabled, 'join.enabled');
    if (raw.join.dailyLimit !== undefined) policy.join.dailyLimit = num(raw.join.dailyLimit, 0, 100, 'join.dailyLimit');
    if (raw.join.allowedTargets !== undefined) {
      if (!Array.isArray(raw.join.allowedTargets) || raw.join.allowedTargets.length > 200) throw new Error('join.allowedTargets must be an array of up to 200 targets');
      policy.join.allowedTargets = raw.join.allowedTargets.map((target, index) => {
        const canonical = typeof target === 'string' && target.length <= 256 ? canonicalJoinTarget(target) : undefined;
        if (!canonical) throw new Error(`join.allowedTargets[${index}] is not a Telegram handle or invite link`);
        return canonical;
      });
    }
  }
  if (raw.confirm !== undefined) {
    only(raw.confirm, ['sources', 'items', 'mediaGiB'], 'confirm');
    for (const [key, max] of [['sources', 1e7], ['items', 1e12], ['mediaGiB', 1e6]]) if (raw.confirm[key] !== undefined) policy.confirm[key] = num(raw.confirm[key], 0, max, 'confirm.' + key);
  }
  if (raw.limits !== undefined) {
    only(raw.limits, ['maxSourcesPerJob', 'maxActiveJobs', 'sliceRecords', 'planTtlMinutes', 'telegramParallel'], 'limits');
    for (const [key, min, max] of [['maxSourcesPerJob', 1, 50000], ['maxActiveJobs', 1, 64], ['sliceRecords', 1, 1000], ['planTtlMinutes', 1, 10080], ['telegramParallel', 1, 3]]) if (raw.limits[key] !== undefined) policy.limits[key] = num(raw.limits[key], min, max, 'limits.' + key);
    if (!Number.isInteger(policy.limits.telegramParallel)) throw new Error('limits.telegramParallel must be an integer from 1 to 3');
  }
  if (raw.governor !== undefined) {
    only(raw.governor, ['history', 'resolve', 'search', 'growAfterMs', 'growFactor', 'backoffFactor', 'cooldownFactor', 'longWaitSeconds', 'breaker', 'providers'], 'governor');
    for (const cls of ['history', 'resolve', 'search']) if (raw.governor[cls] !== undefined) policy.governor[cls] = governorClass(raw.governor[cls], base.governor[cls], 'governor.' + cls);
    for (const [key, min, max] of [['growAfterMs', 1000, 86400000], ['growFactor', 1.01, 10], ['backoffFactor', 1.1, 10], ['cooldownFactor', 1, 5], ['longWaitSeconds', 1, 86400]]) if (raw.governor[key] !== undefined) policy.governor[key] = num(raw.governor[key], min, max, 'governor.' + key);
    if (raw.governor.breaker !== undefined) {
      only(raw.governor.breaker, ['floodsPerHour', 'openMs'], 'governor.breaker');
      if (raw.governor.breaker.floodsPerHour !== undefined) policy.governor.breaker.floodsPerHour = num(raw.governor.breaker.floodsPerHour, 1, 1000, 'governor.breaker.floodsPerHour');
      if (raw.governor.breaker.openMs !== undefined) policy.governor.breaker.openMs = num(raw.governor.breaker.openMs, 1000, 604800000, 'governor.breaker.openMs');
    }
    if (raw.governor.providers !== undefined) {
      only(raw.governor.providers, ['telegram', 'x', 'instagram'], 'governor.providers');
      for (const [provider, classes] of Object.entries(raw.governor.providers)) {
        only(classes, ['history', 'resolve', 'search'], 'governor.providers.' + provider);
        policy.governor.providers[provider] = { ...(policy.governor.providers[provider] ?? {}) };
        for (const [cls, value] of Object.entries(classes)) policy.governor.providers[provider][cls] = governorClass(value, { ...policy.governor[cls], ...(policy.governor.providers[provider][cls] ?? {}) }, `governor.providers.${provider}.${cls}`);
      }
    }
  }
  if (raw.diskReserveGiB !== undefined) policy.diskReserveGiB = num(raw.diskReserveGiB, 0, 1024, 'diskReserveGiB');
  return policy;
}

/** Эффективные параметры регулятора класса для конкретной платформы. */
export function governorFor(policy, provider, cls) {
  const base = policy.governor[cls] ?? policy.governor.history;
  return { ...base, ...(policy.governor.providers?.[provider]?.[cls] ?? {}) };
}

/**
 * Загружает политику. Файл отсутствует — создаётся с умолчаниями (эксклюзивно). Файл повреждён — действуют
 * умолчания (только чтение), причина видна в status; чужие инструменты правят политику не могут.
 */
export async function loadPolicy({ stateRoot, create = true } = {}) {
  const file = path.join(stateRoot, 'policy.json');
  await assertSafeDirectory(stateRoot, { create: true });
  let info = await assertSafeFile(file, { optional: true }).catch(() => 'unsafe');
  if (info === 'unsafe') return { policy: structuredClone(DEFAULT_POLICY), source: 'default', error: 'policy_file_unsafe', file };
  if (!info) {
    if (!create) return { policy: structuredClone(DEFAULT_POLICY), source: 'default', file };
    const temporary = path.join(stateRoot, `.policy-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try { await fs.link(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; } finally { await fs.unlink(temporary).catch(() => {}); }
    info = await assertSafeFile(file);
  }
  try {
    if (info.size > 65536) throw new Error('policy file is larger than 64 KiB');
    return { policy: validatePolicy(JSON.parse(await fs.readFile(file, 'utf8'))), source: 'file', file };
  } catch (error) {
    return { policy: structuredClone(DEFAULT_POLICY), source: 'default', error: 'policy_invalid', detail: String(error.message).slice(0, 160), file };
  }
}

/** Проверка вступления в группу. Бросает POLICY_DENIED; вызывающий пишет отказ в журнал аудита. */
export function checkJoin(policy, channel, joinsToday) {
  const deny = reason => { throw new OrchError('POLICY_DENIED', reason, { recovery: 'Joining groups is off by default. Only the owner can enable join and add this exact target to allowedTargets in policy.json.' }); };
  if (!policy.join.enabled) deny('join is disabled by policy');
  const target = canonicalJoinTarget(channel);
  if (!target || !policy.join.allowedTargets.includes(target)) deny('target is not in policy join.allowedTargets');
  if (joinsToday >= policy.join.dailyLimit) deny('daily join limit reached');
  return target;
}

export function assertReadAllowed(policy) {
  if (!policy.read) throw new OrchError('POLICY_DENIED', 'read is disabled by policy', { recovery: 'Reading is disabled in policy.json; only the owner can enable it.' });
}
