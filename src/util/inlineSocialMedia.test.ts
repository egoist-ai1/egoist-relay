import { describe, expect, test } from 'vitest';

import { parseInlineSocialMediaUrl } from './inlineSocialMedia';

describe('Inline social media URLs', () => {
  test.each(['reel', 'reels', 'p', 'tv'])('Canonicalizes Instagram %s URLs', (path) => {
    const source = parseInlineSocialMediaUrl(`https://www.instagram.com/${path}/AbCdE12345/`);
    expect(source?.canonicalUrl).toBe(`https://www.instagram.com/${path === 'reels' ? 'reel' : path}/AbCdE12345/`);
  });

  test.each([
    'https://x.com/name/status/1234567890123456789',
    'https://twitter.com/i/web/status/1234567890123456789',
    'https://x.com/i/status/1234567890123456789/video/1',
  ])('Canonicalizes X post %s', (url) => {
    expect(parseInlineSocialMediaUrl(url)?.canonicalUrl).toBe('https://x.com/i/status/1234567890123456789');
  });

  test.each([
    'https://x.com.evil.test/name/status/1234567890123456789',
    'https://x.com@evil.test/name/status/1234567890123456789',
    'https://x.com:8443/name/status/1234567890123456789',
    'https://x.com/name/../name/status/1234567890123456789',
    'https://x.com/name/status/%31%32%33%34%35',
    'https://www.youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv',
  ])('Rejects ambiguous or forbidden URL %s', (url) => {
    expect(parseInlineSocialMediaUrl(url)).toBeUndefined();
  });
});
