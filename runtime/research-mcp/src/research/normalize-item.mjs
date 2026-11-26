// Нормализация записей Telegram / X / Instagram в единую запись item (schemaVersion 2).
// Правило проекта: неизвестное значение — null с причиной в gaps, а не выдуманный ноль. Сырой объект остаётся в архиве.
import { createHash } from 'node:crypto';
import { detectLang, foldText, isObject, sha256, stable } from './orch-core.mjs';

export const MAX_TEXT_CHARS = 20000;
export const ITEM_TYPES = Object.freeze(['post', 'comment', 'profile', 'channel']);
const PREFIX = { telegram: 'tg', x: 'x', instagram: 'ig' };

const integer = value => {
  const n = typeof value === 'string' && /^-?\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const metric = value => (isObject(value) ? integer(value.value) : integer(value));
const textOf = value => (typeof value === 'string' && value.length ? value : undefined);

function epochSeconds(record) {
  if (Number.isSafeInteger(record.date) && record.date > 0) return record.date;
  const parsed = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function telegramFields(record) {
  const fields = isObject(record.observedFields) ? record.observedFields : {};
  const peer = String(record.peerId ?? '');
  const from = isObject(fields.fromId) ? (fields.fromId.userId ?? fields.fromId.channelId ?? fields.fromId.chatId) : undefined;
  const reactions = Array.isArray(fields.reactions?.results) ? fields.reactions.results.reduce((sum, item) => sum + (integer(item?.count) ?? 0), 0) : null;
  const reply = integer(fields.replyTo?.replyToMsgId);
  const fwd = isObject(fields.fwdFrom) ? fields.fwdFrom : undefined;
  const fwdChannel = fwd ? (fwd.fromId?.channelId ?? fwd.fromId?.userId) : undefined;
  const media = [];
  const className = fields.media?.className;
  if (className === 'MessageMediaPhoto') media.push({ kind: 'photo', mime: 'image/jpeg', bytes: null });
  else if (className === 'MessageMediaDocument' && isObject(fields.media.document)) {
    const mime = textOf(fields.media.document.mimeType) ?? null;
    media.push({ kind: mime?.startsWith('video/') ? 'video' : mime?.startsWith('audio/') ? 'audio' : 'document', mime, bytes: integer(fields.media.document.size) });
  }
  const links = Array.isArray(fields.entities) ? fields.entities.filter(item => typeof item?.url === 'string').map(item => item.url) : [];
  return {
    authorId: from === undefined ? null : `tg:${from}`, authorName: textOf(fields.postAuthor) ?? null,
    views: integer(fields.views), forwards: integer(fields.forwards), replies: integer(fields.replies?.replies), reactions, likes: null, reposts: null,
    replyTo: reply === null ? null : `tg:${peer}:${reply}`,
    threadId: record.threadId !== undefined ? String(record.threadId) : record.topicId !== undefined ? String(record.topicId) : null,
    originalRef: fwdChannel !== undefined && integer(fwd.channelPost) !== null ? `tg:${fwdChannel}:${fwd.channelPost}` : null,
    media, links,
  };
}

function socialFields(record) {
  const metrics = isObject(record.metrics) ? record.metrics : {};
  // Расширитель DOM Relay (social-read.js) называет вид именем тега: img, video, audio, source, track; размеры лежат в dimensions.
  // source (запасной кодек внутри video или picture) и track (субтитры) — не отдельные вложения: они не считаются.
  const mediaKind = item => {
    const kind = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
    if (['photo', 'video', 'audio', 'document'].includes(kind)) return kind;
    if (kind === 'img') return 'photo';
    if (kind === 'video' || kind === 'audio') return kind;
    if (kind === 'source' || kind === 'track') return undefined;
    return /video|reel/i.test(kind) ? 'video' : 'photo';
  };
  const media = Array.isArray(record.media) ? record.media.filter(isObject).filter(item => mediaKind(item) !== undefined).slice(0, 50).map(item => ({
    kind: mediaKind(item),
    mime: textOf(item.mimeType) ?? null, bytes: integer(item.bytes),
    width: integer(item.width ?? item.dimensions?.width), height: integer(item.height ?? item.dimensions?.height),
  })) : [];
  const links = Array.isArray(record.links) ? [...new Set(record.links.map(item => item?.url).filter(url => typeof url === 'string'))].slice(0, 50) : [];
  const author = isObject(record.author) ? textOf(record.author.observedText) ?? textOf(record.author.name) ?? textOf(record.author.username) : textOf(record.author);
  return {
    authorId: null, authorName: author ?? null,
    views: metric(metrics.views), forwards: null, replies: metric(metrics.reply), reactions: null, likes: metric(metrics.like), reposts: metric(metrics.retweet),
    replyTo: null, threadId: null, originalRef: null, media, links,
  };
}

/** Возвращает { item } либо { skip: причина } для типов, которые этап 1 не хранит. */
export function normalizeRecord(provider, record) {
  if (!isObject(record) || typeof record.type !== 'string') return { skip: 'record_shape' };
  const raw = record.type;
  let type;
  if (raw === 'telegram.message' || raw === 'post' || raw === 'reel') type = 'post';
  else if (raw === 'profile') type = 'profile';
  else if (raw === 'telegram.chat') type = 'channel';
  else return { skip: 'type_' + raw.slice(0, 40) };
  const idText = typeof record.id === 'string' || Number.isSafeInteger(record.id) ? String(record.id) : undefined;
  if (!idText) return { skip: 'record_without_id' };
  const prefix = PREFIX[provider];
  const publicId = provider === 'telegram' ? `tg:${type === 'channel' ? 'chat:' : ''}${idText}` : provider === 'instagram' ? `ig:${idText.replace(/^(?:instagram|ig):/, '')}` : idText.startsWith(prefix + ':') ? idText : `${prefix}:${idText}`;
  const fields = provider === 'telegram' && type === 'post' ? telegramFields(record) : socialFields(record);
  let text = textOf(record.text) ?? textOf(record.caption) ?? textOf(record.observedText) ?? (type === 'channel' || type === 'profile' ? textOf(record.description) ?? textOf(record.title) : undefined) ?? null;
  const textTruncated = text !== null && text.length > MAX_TEXT_CHARS;
  if (textTruncated) text = text.slice(0, MAX_TEXT_CHARS);
  const ts = type === 'post' ? epochSeconds(record) : 0;
  const gaps = Array.isArray(record.unresolvedFields) ? record.unresolvedFields.filter(item => typeof item === 'string').slice(0, 20) : [];
  if (type === 'post' && !ts) gaps.push('timestamp_not_observed');
  if (type === 'post' && fields.authorId === null && fields.authorName === null) gaps.push('author_not_observed');
  if (type === 'post' && [fields.views, fields.forwards, fields.replies, fields.reactions, fields.likes, fields.reposts].every(value => value === null)) gaps.push('metrics_not_observed');
  const metricsExtra = type === 'profile' && isObject(record.metrics) ? Object.fromEntries(['followers', 'following'].map(name => [name, metric(record.metrics[name])]).filter(([, value]) => value !== null)) : null;
  const folded = text === null ? '' : foldText(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const core = { id: publicId, type, ts, text, authorId: fields.authorId, authorName: fields.authorName, views: fields.views, forwards: fields.forwards, replies: fields.replies, reactions: fields.reactions, likes: fields.likes, reposts: fields.reposts, replyTo: fields.replyTo, threadId: fields.threadId, originalRef: fields.originalRef };
  return {
    item: {
      provider, type, itemId: `${type}:${publicId}`, publicId, ts,
      authorId: fields.authorId, authorName: fields.authorName ? fields.authorName.slice(0, 200) : null,
      text, textTruncated, lang: text ? detectLang(text) : null,
      views: fields.views, forwards: fields.forwards, replies: fields.replies, reactions: fields.reactions, likes: fields.likes, reposts: fields.reposts,
      replyTo: fields.replyTo, threadId: fields.threadId, originalRef: fields.originalRef,
      media: fields.media, links: fields.links, gaps, metricsExtra,
      contentSha: sha256(stable(core)).slice(0, 32),
      textFp: folded.length >= 20 ? createHash('sha256').update(folded).digest('hex').slice(0, 16) : null,
    },
  };
}
