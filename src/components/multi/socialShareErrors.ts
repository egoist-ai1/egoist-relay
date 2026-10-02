export type SocialShareError = 'media' | 'send' | 'restricted' | 'close'
  | 'mediaAuth' | 'mediaForbidden' | 'mediaUnavailable' | 'mediaRateLimited' | 'mediaConnection'
  | 'mediaLimit' | 'mediaDiskFull';

export function classifySocialShareMediaError(error: unknown): SocialShareError {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const code = message.slice(0, 512).match(/\bMEDIA_[A-Z_]+\b/)?.[0];
  switch (code) {
    case 'MEDIA_DISK_FULL': return 'mediaDiskFull';
    case 'MEDIA_AUTH_REQUIRED': return 'mediaAuth';
    case 'MEDIA_HTTP_FORBIDDEN': return 'mediaForbidden';
    case 'MEDIA_UNAVAILABLE': return 'mediaUnavailable';
    case 'MEDIA_RATE_LIMITED': return 'mediaRateLimited';
    case 'MEDIA_FETCH_FAILED': return 'mediaConnection';
    case 'MEDIA_TOO_LARGE':
    case 'MEDIA_TOO_LONG': return 'mediaLimit';
    default: return 'media';
  }
}
