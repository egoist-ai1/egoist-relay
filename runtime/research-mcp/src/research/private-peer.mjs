// Личные диалоги Telegram. Relay читает историю любого собеседника аккаунта (пользователь, бот, «Избранное»), а политика владельца
// `readPrivateThread` по умолчанию ложна. Идентификатор пользователя в записях Relay — положительное число; каналы и группы
// отрицательные (`-100…`, `-…`). Проверка стоит на границе моста: запись личного диалога не принимается, источник получает ACCESS_DENIED.
const POSITIVE_PEER = /^\d{1,20}$/;

export function isPrivateTelegramRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.type === 'telegram.message') return POSITIVE_PEER.test(String(record.peerId ?? ''));
  if (record.type === 'telegram.chat') return POSITIVE_PEER.test(String(record.id ?? ''));
  return false;
}

/** Бросает ACCESS_DENIED, если запись относится к личному диалогу, а владелец его не разрешил. */
export function assertPrivatePeerAllowed(provider, record, allowed) {
  if (provider === 'telegram' && !allowed() && isPrivateTelegramRecord(record)) {
    throw Object.assign(new Error('ACCESS_DENIED'), { code: 'ACCESS_DENIED', reason: 'private_dialog_denied_by_policy' });
  }
}
