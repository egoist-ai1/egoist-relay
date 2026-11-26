export const MAX_NATIVE_LINKS = 16;
const MAX_LINK_LENGTH = 16384;
const TELEGRAM_LINK_HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'telegram.dog']);
const TELEGRAM_WEB_HOST = 'web.telegram.org';
const TELEGRAM_PUBLIC_SUBDOMAIN = /^[a-z][\da-z_]{1,31}\.t\.me$/i;
const WEB_USER_LOCATION = /^#@([a-z][\da-z_]{0,31})(?:\/(\d{1,10}))?$/i;
const WEB_CHAT_LOCATION = /^#(-?\d{1,20})(?:([/_])(\d{1,10}))?$/;

export function parseTelegramWebChat(url: URL) {
  if (!isTelegramWebUrl(url)) return undefined;
  const match = url.hash.match(WEB_CHAT_LOCATION);
  if (!match) return undefined;
  const [, id, separator, point] = match;
  const target = point === undefined ? undefined : Number(point);
  return { id, threadId: separator === '_' ? target : undefined, messageId: separator === '/' ? target : undefined };
}

export function isTelegramWebUrl(url: URL) {
  return url.protocol === 'https:' && url.hostname === TELEGRAM_WEB_HOST
    && !url.username && !url.password && !url.port && /^\/[akz]\/?$/.test(url.pathname)
    && [...url.searchParams].every(([key, value]) => key === 'account' && /^\d{1,3}$/.test(value));
}

function normalizeTelegramWebUrl(url: URL) {
  if (!isTelegramWebUrl(url)) return undefined;
  const match = url.hash.match(WEB_USER_LOCATION);
  if (match) return `https://t.me/${match.slice(1).filter(Boolean).join('/')}`;
  if (!url.hash || parseTelegramWebChat(url)) return url.toString();
  return undefined;
}

export function normalizeNativeDeepLinks(payload: unknown): string[] {
  const values = Array.isArray(payload) ? payload.slice(0, MAX_NATIVE_LINKS) : [payload];
  const links: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value || value.length > MAX_LINK_LENGTH
      || Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) continue;
    try {
      const decoded = /^tg%3a/i.test(value) ? decodeURIComponent(value) : value;
      const link = decoded.replace(/^tg:(\/\/)?/i, 'tg://');
      // Validate escapes without decoding query delimiters before the URL parser.
      decodeURIComponent(link);
      const url = new URL(link);
      if (!url.hostname || url.username || url.password || url.port) continue;
      if (url.protocol === 'tg:') {
        links.push(link);
      } else if (url.hostname === TELEGRAM_WEB_HOST) {
        const normalized = normalizeTelegramWebUrl(url);
        if (normalized) links.push(normalized);
      } else if (url.protocol === 'https:') {
        if (TELEGRAM_LINK_HOSTS.has(url.hostname) && url.pathname !== '/') {
          if (url.hostname === 'www.t.me') {
            url.hostname = 't.me';
            links.push(url.toString());
          } else {
            links.push(link);
          }
        } else if (TELEGRAM_PUBLIC_SUBDOMAIN.test(url.hostname)) {
          const username = url.hostname.split('.')[0];
          links.push(`https://t.me/${username}${url.pathname}${url.search}`);
        }
      }
    } catch {
      // An invalid element must not prevent later valid links from opening.
    }
  }
  return links;
}
