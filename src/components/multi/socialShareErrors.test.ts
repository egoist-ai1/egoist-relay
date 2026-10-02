import { expect, it } from 'vitest';

import { classifySocialShareMediaError } from './socialShareErrors';

it.each([
  ['MEDIA_AUTH_REQUIRED', 'mediaAuth'], ['MEDIA_HTTP_FORBIDDEN', 'mediaForbidden'],
  ['MEDIA_UNAVAILABLE', 'mediaUnavailable'], ['MEDIA_RATE_LIMITED', 'mediaRateLimited'],
  ['MEDIA_FETCH_FAILED', 'mediaConnection'], ['MEDIA_TOO_LARGE', 'mediaLimit'], ['MEDIA_TOO_LONG', 'mediaLimit'],
  ['MEDIA_FORMAT_UNSUPPORTED', 'media'], ['PRIVATE_ENDPOINT_IN_ERROR', 'media'],
])('maps safe media code %s without presenting raw backend text', (message, expected) => {
  expect(classifySocialShareMediaError(message)).toBe(expected);
  expect(classifySocialShareMediaError(new Error(message))).toBe(expected);
});

it('handles non-error payloads without invoking their methods', () => {
  expect(classifySocialShareMediaError({
    toString: () => {
      throw new Error('Unexpected coercion');
    },
  })).toBe('media');
});
