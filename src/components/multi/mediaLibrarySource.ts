import { parseInlineSocialMediaUrl } from '../../util/inlineSocialMedia';
import { normalizeNativeDeepLinks } from '../../util/tauri/deepLinks';

export type LibraryEntry = {
  id: string;
  service: 'telegram' | 'x' | 'instagram';
  sourceUrl?: string;
  fileName: string;
  mimeType: string;
  size: number;
  savedAt: number;
  isLink?: boolean;
};

export type LibrarySnapshot = { isLocked: boolean; entries: LibraryEntry[]; error?: string };

const PUBLIC_TELEGRAM_POST = /^\/(?:s\/)?[a-zA-Z][a-zA-Z\d_]{3,31}\/[1-9]\d*\/?$/;

export function getSourceUrl(entry: LibraryEntry) {
  if (!entry.sourceUrl) return undefined;
  if (entry.service !== 'telegram') {
    const source = parseInlineSocialMediaUrl(entry.sourceUrl);
    return source?.provider === entry.service ? source.canonicalUrl : undefined;
  }
  const link = normalizeNativeDeepLinks(entry.sourceUrl)[0];
  if (!link) return undefined;
  const url = new URL(link);
  if (url.protocol !== 'https:' || !PUBLIC_TELEGRAM_POST.test(url.pathname)) return undefined;
  return `${url.origin}${url.pathname}`;
}
