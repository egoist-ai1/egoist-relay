// Объявление возможностей Relay (этап 2, аддитивно): поля `maxConcurrent` и `features` записи Telegram в событии status.
// Демон шлёт новое поле входа только после того, как Relay объявил соответствующую возможность; без объявления всё как на этапе 1.
export const FEATURE_PATTERN = /^[a-z0-9_]{1,32}$/;
export const MAX_FEATURES = 16;
export const MAX_RELAY_PARALLEL = 3;
export const KNOWN_FEATURES = Object.freeze(['offset_date', 'min_id', 'probe', 'flood_wait', 'peer_cache', 'media_resume', 'media_spool', 'comments', 'topics', 'similar_channels', 'invite_preview']);

/** Объявление по умолчанию: один запуск, ни одной возможности. */
export const NO_ADVERT = Object.freeze({ maxConcurrent: 1, features: Object.freeze(new Set()) });

/**
 * Проверяет объявление записи платформы. Только Telegram: для остальных платформ контракт ничего не объявляет.
 * Неверное значение не ослабляет проверку: maxConcurrent вне 1..3 → 1, список длиннее 16 или с чужим идентификатором → пустой.
 */
export function parseBridgeAdvert(selected, provider) {
  if (provider !== 'telegram' || !selected || typeof selected !== 'object') return NO_ADVERT;
  const maxConcurrent = Number.isSafeInteger(selected.maxConcurrent) && selected.maxConcurrent >= 1 && selected.maxConcurrent <= MAX_RELAY_PARALLEL ? selected.maxConcurrent : 1;
  const list = selected.features;
  const valid = Array.isArray(list) && list.length <= MAX_FEATURES && list.every(item => typeof item === 'string' && FEATURE_PATTERN.test(item));
  return { maxConcurrent, features: new Set(valid ? list : []) };
}
