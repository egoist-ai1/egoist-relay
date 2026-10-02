import { describe, expect, test } from 'vitest';

import buildDocumentClipboardText from './documentClipboard';

describe('Document clipboard content', () => {
  test.each(['txt', 'md', 'xml', 'html', 'tsx'])('Preserves literal text for %s', (extension) => {
    const text = 'a < b > c\n<tag attribute="test"> &amp;';
    expect(buildDocumentClipboardText(text, extension)).toBe(text);
  });

  test('Decodes DOCX preview entities and preserves paragraph boundaries', () => {
    expect(buildDocumentClipboardText('<p>First &amp; &lt;tag&gt;</p><p>Second<br>line</p>', 'docx'))
      .toBe('First & <tag>\nSecond\nline');
  });
});
