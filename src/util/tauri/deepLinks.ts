const MAX_LINKS = 16;
const MAX_LINK_LENGTH = 16384;

export function normalizeNativeDeepLinks(payload: unknown): string[] {
  const values = Array.isArray(payload) ? payload.slice(0, MAX_LINKS) : [payload];
  const links: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value || value.length > MAX_LINK_LENGTH
      || Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) continue;
    try {
      const link = /^tg%3a/i.test(value) ? decodeURIComponent(value) : value;
      // Validate escapes without decoding query delimiters before the URL parser.
      decodeURIComponent(link);
      const url = new URL(link);
      if (url.protocol !== 'tg:' || !url.hostname || url.username || url.password) continue;
      links.push(link);
    } catch {
      // An invalid element must not prevent later valid links from opening.
    }
  }
  return links;
}
