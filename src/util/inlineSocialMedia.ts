import type { ApiFormattedText, ApiWebPage } from '../api/types';
import { ApiMessageEntityTypes } from '../api/types';

export type InlineSocialMediaSource = {
  provider: 'youtube' | 'instagram' | 'x';
  id: string;
  canonicalUrl: string;
  isVertical: boolean;
};

export const INLINE_MEDIA_OPEN_EVENT = 'egoist-relay-inline-media-open';
export const INLINE_MEDIA_SERVICE_EVENT = 'egoist-relay-service-change';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const YOUTUBE_ID = /^[\w-]{11}$/;
const INSTAGRAM_ID = /^[\w-]{5,64}$/;
const X_ID = /^[1-9]\d{4,19}$/;

export function parseInlineSocialMediaUrl(input?: string): InlineSocialMediaSource | undefined {
  if (typeof input !== 'string' || !input || /[\s\\\p{Control}]/u.test(input)) return undefined;
  const rawPath = input.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1];
  if (rawPath?.includes('%') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath || '')) return undefined;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname.includes('%')) {
    return undefined;
  }
  const host = url.hostname;
  if (YOUTUBE_HOSTS.has(host) || host === 'youtu.be') {
    const path = url.pathname.replace(/\/$/, '');
    const isVertical = path.startsWith('/shorts/');
    const id = host === 'youtu.be' ? path.slice(1)
      : path === '/watch' && url.searchParams.getAll('v').length === 1 ? url.searchParams.get('v')
        : /^\/(?:shorts|embed)\/[\w-]+$/.test(path) ? path.split('/')[2] : undefined;
    if (!id || !YOUTUBE_ID.test(id)) return undefined;
    return { provider: 'youtube', id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`, isVertical };
  }
  if (INSTAGRAM_HOSTS.has(host)) {
    const match = url.pathname.match(/^\/(reel|reels|p|tv)\/([\w-]+)\/?$/);
    if (!match || !INSTAGRAM_ID.test(match[2])) return undefined;
    return {
      provider: 'instagram', id: match[2],
      canonicalUrl: `https://www.instagram.com/${match[1] === 'reels' ? 'reel' : match[1]}/${match[2]}/`,
      isVertical: match[1] !== 'p',
    };
  }
  if (X_HOSTS.has(host)) {
    const postPath = /^\/(?:[\w]{1,15}\/status|i\/status|i\/web\/status)\/(\d+)(?:\/(?:video|photo)\/[1-4])?\/?$/;
    const match = url.pathname.match(postPath);
    if (!match || !X_ID.test(match[1])) return undefined;
    return { provider: 'x', id: match[1], canonicalUrl: `https://x.com/i/status/${match[1]}`, isVertical: false };
  }
  return undefined;
}

export function findInlineSocialMediaUrl(text?: ApiFormattedText): string | undefined {
  if (!text) return undefined;
  for (const entity of text.entities || []) {
    if (entity.type === ApiMessageEntityTypes.TextUrl && parseInlineSocialMediaUrl(entity.url)) return entity.url;
    if (entity.type === ApiMessageEntityTypes.Url) {
      const url = text.text.slice(entity.offset, entity.offset + entity.length);
      if (parseInlineSocialMediaUrl(url)) return url;
    }
  }
  return text.text.match(/https:\/\/[^\s<>]+/g)?.find((url) => Boolean(parseInlineSocialMediaUrl(url)));
}

export function shouldUseNativeInlineSocialMediaPreview(
  hasNativeMedia: boolean, previewUrl?: string, selectedUrl?: string,
): boolean {
  if (!hasNativeMedia) return false;
  if (!selectedUrl) return true;
  const selectedSource = parseInlineSocialMediaUrl(selectedUrl);
  const previewSource = parseInlineSocialMediaUrl(previewUrl);
  return Boolean(selectedSource && previewSource && selectedSource.canonicalUrl === previewSource.canonicalUrl);
}

export function hasNativeInlineSocialMediaPreview(webPage?: ApiWebPage): boolean {
  if (webPage?.webpageType !== 'full') return false;
  if (webPage.video || webPage.audio || webPage.document) return true;
  const source = parseInlineSocialMediaUrl(webPage.url);
  if (source?.provider === 'x' && webPage.type === 'article' && !webPage.photo
    && (webPage.title?.trim() || webPage.description?.trim())) return true;
  return Boolean(webPage.photo && webPage.type === 'photo'
    && (source?.provider === 'x' || (source?.provider === 'instagram' && !source.isVertical)));
}

export function buildInlineSocialMediaEmbedUrl(source: InlineSocialMediaSource, canPlay: boolean, origin: string) {
  if (source.provider === 'instagram') return `${source.canonicalUrl}embed/?cr=1`;
  if (source.provider === 'x') {
    return `https://platform.twitter.com/embed/Tweet.html?id=${source.id}&dnt=true`;
  }
  const url = new URL(`https://www.youtube-nocookie.com/embed/${source.id}`);
  url.searchParams.set('enablejsapi', '1');
  url.searchParams.set('playsinline', '1');
  url.searchParams.set('autoplay', canPlay ? '1' : '0');
  url.searchParams.set('mute', '1');
  if (/^https?:\/\//.test(origin)) url.searchParams.set('origin', origin);
  return url.href;
}
