// Точечные чтения Telegram без вступления и отправки: предпросмотр инвайта, похожие каналы, темы форума, комментарии под постом.
// Здесь только разбор и проверка входа и компактное представление записей; темп, политика и вызов моста — в orchestrator.lookup.
import { OrchError, fail, isObject, isoTime, looksSecret } from './orch-core.mjs';
import { canonicalSource } from './source-input.mjs';
import { normalizeRecord } from './normalize-item.mjs';

// cls — класс регулятора темпа: одиночные запросы разрешения (invite, похожие) идут как resolve, постраничное чтение — как history.
export const LOOKUPS = Object.freeze({
  invite_preview: { cls: 'resolve', fields: ['invite'], defaultLimit: 1, maxLimit: 1 },
  similar_channels: { cls: 'resolve', fields: ['channel', 'limit'], defaultLimit: 20, maxLimit: 100 },
  topics: { cls: 'history', fields: ['channel', 'query', 'limit', 'cursor'], defaultLimit: 50, maxLimit: 100 },
  comments: { cls: 'history', fields: ['url', 'limit', 'cursor'], defaultLimit: 50, maxLimit: 100 },
});
const INVITE_HASH = /^[A-Za-z0-9_-]{5,128}$/;
const TEXT_CHARS = 600;
const deny = reason => { throw new OrchError('POLICY_DENIED', reason, { recovery: 'Personal dialogs are off by owner policy (readPrivateThread). Only the owner can change policy.json.' }); };

function inviteLink(value) {
  const text = String(value).trim();
  if (/[\u0000-\u001f\u007f]/.test(text) || looksSecret(text)) fail('INVALID_INPUT', 'invite is not a Telegram invite link.');
  const bare = /^\+([A-Za-z0-9_-]{5,128})$/.exec(text);
  let hash = bare?.[1];
  if (!hash) {
    let url;
    try { url = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); } catch { fail('INVALID_INPUT', 'invite is not a Telegram invite link.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(url.hostname.toLowerCase())) fail('INVALID_INPUT', 'invite must be a t.me invite link.');
    hash = /^\/(?:\+|joinchat\/)([A-Za-z0-9_-]{5,128})\/?$/.exec(url.pathname)?.[1];
  }
  if (!hash || !INVITE_HASH.test(hash)) fail('INVALID_INPUT', 'invite must look like https://t.me/+CODE.');
  return `https://t.me/+${hash}`;
}

/** Строгий разбор входа. Возвращает { kind, limit, ...вход для моста }; бросает INVALID_INPUT / POLICY_DENIED. */
export function parseLookup(params, { allowPrivate = false } = {}) {
  if (!isObject(params)) fail('INVALID_INPUT', 'arguments must be an object.');
  const spec = LOOKUPS[params.kind];
  if (!spec) fail('INVALID_INPUT', 'kind is unknown.');
  for (const key of Object.keys(params)) if (key !== 'kind' && !spec.fields.includes(key)) fail('INVALID_INPUT', `${key} is not supported for ${params.kind}.`);
  const limit = params.limit ?? spec.defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > spec.maxLimit) fail('INVALID_INPUT', `limit must be 1..${spec.maxLimit}.`);
  const request = { kind: params.kind, limit };
  if (params.kind === 'invite_preview') {
    if (typeof params.invite !== 'string') fail('INVALID_INPUT', 'invite is required.');
    request.channel = inviteLink(params.invite);
    return request;
  }
  const given = params.kind === 'comments' ? params.url : params.channel;
  if (typeof given !== 'string' || !given.trim()) fail('INVALID_INPUT', params.kind === 'comments' ? 'url of the post is required.' : 'channel is required.');
  const source = canonicalSource('telegram', given);
  if (params.kind === 'comments') {
    if (source.kind !== 'post') fail('INVALID_INPUT', 'url must point to one channel post, for example https://t.me/name/123.');
    const url = new URL(source.ref);
    request.url = url.origin + url.pathname;
  } else {
    if (source.kind !== 'channel') fail('INVALID_INPUT', 'channel must be a channel or group handle, link or numeric ID.');
    if (/^peer:\d+$/.test(source.canonical) && !allowPrivate) deny('personal dialogs are off by owner policy');
    request.channel = source.ref;
  }
  if (params.query !== undefined) {
    if (typeof params.query !== 'string' || !params.query.trim() || params.query.length > 128 || /[\u0000-\u001f\u007f]/.test(params.query)) fail('INVALID_INPUT', 'query must be 1..128 characters.');
    request.query = params.query.trim();
  }
  if (params.cursor !== undefined) {
    if (typeof params.cursor !== 'string' || !params.cursor || params.cursor.length > 2048 || looksSecret(params.cursor)) fail('INVALID_INPUT', 'cursor is invalid.');
    request.cursor = params.cursor;
  }
  return request;
}

// Поля приходят от Relay и недоверенны: строки обрезаются (about — 600, остальные — 200 символов), числа должны быть конечными.
const LONG_FIELDS = new Set(['about']);
const pick = (source, names) => {
  const result = {};
  if (isObject(source)) {
    for (const name of names) {
      const value = source[name];
      if (typeof value === 'string') result[name] = value.slice(0, LONG_FIELDS.has(name) ? 600 : 200);
      else if (typeof value === 'number' && Number.isFinite(value)) result[name] = value;
      else if (typeof value === 'boolean') result[name] = value;
    }
  }
  return result;
};
const TG_URL = /^https:\/\/t\.me\/[A-Za-z0-9_+\-/.]{1,150}$/;

/** Компактное представление записи Relay: без сырого объекта платформы, текст обрезан. Недоверенные поля помечает вызывающий. */
export function projectLookupRecord(kind, record) {
  if (!isObject(record)) return undefined;
  if (kind === 'invite_preview') {
    return { ...pick(record, ['membershipState', 'title', 'about', 'participantsCount', 'isChannel', 'isBroadcast', 'isMegagroup', 'isPublic', 'requestNeeded', 'verified', 'scam', 'fake', 'isPaid']), ...(typeof record.peerId === 'string' ? { peerId: record.peerId.slice(0, 200) } : {}) };
  }
  if (kind === 'topics') {
    if (!Number.isSafeInteger(record.topicId)) return undefined;
    return { topicId: record.topicId, title: typeof record.title === 'string' ? record.title.slice(0, 200) : null, ...(Number.isSafeInteger(record.date) ? { date: isoTime(record.date * 1000) } : {}) };
  }
  if (kind === 'similar_channels') {
    const fields = isObject(record.observedFields) ? record.observedFields : {};
    const id = typeof record.id === 'string' ? record.id.slice(0, 200) : Number.isSafeInteger(record.id) ? String(record.id) : '';
    if (!id) return undefined;
    return { id, ...(typeof record.sourceUrl === 'string' && TG_URL.test(record.sourceUrl) ? { url: record.sourceUrl } : {}), ...pick(fields, ['title', 'username', 'participantsCount', 'broadcast', 'megagroup', 'verified', 'scam', 'fake']) };
  }
  // comments: те же поля, что у записей постов, без сырого объекта
  const normalized = normalizeRecord('telegram', record);
  if (normalized.skip) return undefined;
  const item = normalized.item;
  const text = item.text === null ? null : item.text.slice(0, TEXT_CHARS);
  return {
    id: item.publicId, ts: item.ts ? isoTime(item.ts * 1000) : null, author: item.authorId ? { id: item.authorId, name: item.authorName } : null,
    text, ...(item.text !== null && item.text.length > TEXT_CHARS ? { textTruncated: true } : {}),
    replies: item.replies, reactions: item.reactions, ...(item.replyTo ? { replyTo: item.replyTo } : {}),
    ...(isObject(record.commentOn) ? { commentOn: `tg:${record.commentOn.peerId}:${record.commentOn.messageId}` } : {}),
  };
}
