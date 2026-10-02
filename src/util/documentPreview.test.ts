import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  decodeDocumentPreviewText, DocumentPreviewError, highlightDocumentHtml, isTextDocumentExtension, limitDocumentPreview,
  MAX_DOCUMENT_PREVIEW_CHARS, MAX_DOCUMENT_PREVIEW_LINES, MAX_DOCUMENT_SEARCH_MATCHES,
  MAX_DOCX_PREVIEW_BYTES, parseDocxPreview, parseMarkdownPreview, readDocumentPreviewBytes,
} from './documentPreview';

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function buildDocx(body: string) {
  return zipSync({
    'word/document.xml': strToU8(`<a:document xmlns:a="${WORD_NAMESPACE}"><a:body>${body}</a:body></a:document>`),
  });
}

function buildDuplicateDocx() {
  const archive = buildDocx('<a:p><a:r><a:t>Text</a:t></a:r></a:p>');
  const endOffset = archive.byteLength - 22;
  const end = archive.slice(endOffset);
  const endView = new DataView(end.buffer);
  const centralOffset = endView.getUint32(16, true);
  const local = archive.slice(0, centralOffset);
  const central = archive.slice(centralOffset, endOffset);
  const secondCentral = central.slice();
  new DataView(secondCentral.buffer).setUint32(42, local.byteLength, true);
  endView.setUint16(8, 2, true);
  endView.setUint16(10, 2, true);
  endView.setUint32(12, central.byteLength * 2, true);
  endView.setUint32(16, local.byteLength * 2, true);
  const duplicated = new Uint8Array(local.byteLength * 2 + central.byteLength * 2 + end.byteLength);
  duplicated.set(local);
  duplicated.set(local, local.byteLength);
  duplicated.set(central, local.byteLength * 2);
  duplicated.set(secondCentral, local.byteLength * 2 + central.byteLength);
  duplicated.set(end, local.byteLength * 2 + central.byteLength * 2);
  return duplicated;
}

function forgeDocumentXmlSize(archive: Uint8Array, size: number) {
  const result = archive.slice();
  const view = new DataView(result.buffer);
  const centralOffset = view.getUint32(result.byteLength - 6, true);
  view.setUint32(centralOffset + 24, size, true);
  view.setUint32(22, size, true);
  return result;
}

afterEach(() => vi.unstubAllGlobals());

describe('Bounded document preview', () => {
  test.each(['little', 'big'] as const)('Reads Cyrillic UTF16 with a %s endian BOM', (endian) => {
    const text = 'Кириллица';
    const bytes = new Uint8Array(2 + text.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xFEFF, endian === 'little');
    for (let index = 0; index < text.length; index++) {
      view.setUint16(2 + index * 2, text.charCodeAt(index), endian === 'little');
    }
    expect(decodeDocumentPreviewText(bytes)).toBe(text);
  });

  test.each(['htm', 'h', 'hpp', 'java', 'go', 'php', 'rb', 'bat', 'ps1', 'conf', 'config'])(
    'Renders declared text extension %s', (extension) => {
      expect(isTextDocumentExtension(extension)).toBe(true);
    },
  );

  test.each(['exe', 'zip', 'pdf', 'md', 'docx'])('Does not route %s into the text renderer', (extension) => {
    expect(isTextDocumentExtension(extension)).toBe(false);
  });

  test('Limits lines and reports truncation without dropping ordinary short content', () => {
    const large = Array.from({ length: 20000 }, (_, index) => `Line ${index}`).join('\n');
    const preview = limitDocumentPreview(large);
    expect(preview.isTruncated).toBe(true);
    expect(preview.content.split('\n')).toHaveLength(MAX_DOCUMENT_PREVIEW_LINES);
    expect(limitDocumentPreview('First\nSecond')).toEqual({ content: 'First\nSecond', isTruncated: false });
  });

  test('Limits a single giant line', () => {
    const preview = limitDocumentPreview('a'.repeat(MAX_DOCUMENT_PREVIEW_CHARS + 1));
    expect(preview.content).toHaveLength(MAX_DOCUMENT_PREVIEW_CHARS);
    expect(preview.isTruncated).toBe(true);
  });

  test('Accepts streamed content without a declared size', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('Text'))));
    const bytes = await readDocumentPreviewBytes('blob:audit', 10, new AbortController().signal);
    expect(new TextDecoder().decode(bytes)).toBe('Text');
  });

  test('Rejects a failed response with a safe error code', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('private server data', { status: 403 }))));
    await expect(readDocumentPreviewBytes('blob:audit', 10, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  test('Rejects an excessive declared size before reading the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body, { headers: { 'content-length': '11' } }))));
    await expect(readDocumentPreviewBytes('blob:audit', 10, new AbortController().signal))
      .rejects.toMatchObject({ code: 'tooLarge' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('Cancels an unannounced oversized stream before allocating it', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body))));
    await expect(readDocumentPreviewBytes('blob:audit', 10, new AbortController().signal))
      .rejects.toMatchObject({ code: 'tooLarge' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('Cancels a pending read when the dialog closes', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body))));
    const controller = new AbortController();
    const pending = readDocumentPreviewBytes('blob:audit', 10, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('DOCX and Markdown preview', () => {
  test('Reads namespaces independently of the w prefix and escapes document text', () => {
    const preview = parseDocxPreview(buildDocx('<a:p><a:r><a:t>&lt;script&gt;&amp;</a:t></a:r></a:p>'));
    expect(preview).toEqual({ content: '<p>&lt;script&gt;&amp;</p>', isTruncated: false });
  });

  test('Preserves plain and formatted runs including explicit false formatting', () => {
    const preview = parseDocxPreview(buildDocx('<a:p><a:r><a:rPr><a:b a:val="false"/></a:rPr>'
      + '<a:t>Plain</a:t><a:tab/><a:t>Text</a:t><a:br/><a:t>Next</a:t></a:r></a:p>'));
    expect(preview.content).toBe('<p>Plain\tText<br>Next</p>');
  });

  test('Rejects malformed and missing document XML with a safe typed failure', () => {
    expect(() => parseDocxPreview(new Uint8Array([1, 2, 3]))).toThrow(DocumentPreviewError);
    expect(() => parseDocxPreview(zipSync({ 'other.xml': strToU8('invalid') })))
      .toThrow('invalidDocx');
    expect(() => parseDocxPreview(zipSync({ 'word/document.xml': strToU8('<w:broken>') })))
      .toThrow('invalidDocx');
  });

  test('Rejects a highly compressed oversized document XML', () => {
    const archive = zipSync({ 'word/document.xml': strToU8('a'.repeat(MAX_DOCX_PREVIEW_BYTES + 1)) });
    expect(archive.byteLength).toBeLessThan(MAX_DOCX_PREVIEW_BYTES);
    expect(() => parseDocxPreview(archive)).toThrow('tooLarge');
  });

  test('Stops actual inflated output even when archive sizes are forged small', () => {
    const archive = zipSync({ 'word/document.xml': strToU8('a'.repeat(MAX_DOCX_PREVIEW_BYTES * 2)) });
    expect(() => parseDocxPreview(forgeDocumentXmlSize(archive, 1))).toThrow('tooLarge');
  });

  test('Rejects inconsistent declared output sizes instead of silently truncating XML', () => {
    const archive = buildDocx('<a:p><a:r><a:t>Text</a:t></a:r></a:p>');
    expect(() => parseDocxPreview(forgeDocumentXmlSize(archive, 1))).toThrow('invalidDocx');
  });

  test('Reads stored XML and rejects encrypted or unsupported compression metadata', () => {
    const archive = zipSync({
      'word/document.xml': strToU8(`<a:document xmlns:a="${WORD_NAMESPACE}">`
        + '<a:body><a:p><a:r><a:t>Stored</a:t></a:r></a:p></a:body></a:document>'),
    }, { level: 0 });
    expect(parseDocxPreview(archive).content).toBe('<p>Stored</p>');
    const encrypted = archive.slice();
    const view = new DataView(encrypted.buffer);
    const centralOffset = view.getUint32(encrypted.byteLength - 6, true);
    view.setUint16(centralOffset + 8, 1, true);
    expect(() => parseDocxPreview(encrypted)).toThrow('invalidDocx');
    view.setUint16(centralOffset + 8, 0, true);
    view.setUint16(centralOffset + 10, 9, true);
    expect(() => parseDocxPreview(encrypted)).toThrow('invalidDocx');
  });

  test('Rejects out of range ZIP offsets and mismatched local document names', () => {
    const archive = buildDocx('<a:p><a:r><a:t>Text</a:t></a:r></a:p>');
    const offset = archive.slice();
    const view = new DataView(offset.buffer);
    const centralOffset = view.getUint32(offset.byteLength - 6, true);
    view.setUint32(centralOffset + 42, 0xFFFFFFFF, true);
    expect(() => parseDocxPreview(offset)).toThrow('invalidDocx');
    const name = archive.slice();
    name[30] = 0x78;
    expect(() => parseDocxPreview(name)).toThrow('invalidDocx');
  });

  test('Rejects duplicate essential document entries before a second inflate', () => {
    expect(() => parseDocxPreview(buildDuplicateDocx())).toThrow('invalidDocx');
  });

  test('Stops archive metadata processing after the bounded entry count', () => {
    const entries = Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [
      `extras/${index}.xml`, new Uint8Array(),
    ]));
    expect(() => parseDocxPreview(zipSync(entries))).toThrow('tooLarge');
  });

  test('Caps DOCX blocks and repeated line breaks before rendering', () => {
    const paragraph = '<a:p><a:r><a:t>Line</a:t></a:r></a:p>';
    const preview = parseDocxPreview(buildDocx(paragraph.repeat(MAX_DOCUMENT_PREVIEW_LINES + 2)));
    expect(preview.isTruncated).toBe(true);
    expect((preview.content.match(/<p>/g) || []).length).toBeLessThanOrEqual(MAX_DOCUMENT_PREVIEW_LINES);
    const breaks = parseDocxPreview(buildDocx(`<a:p><a:r><a:t>Line</a:t>${'<a:br/>'.repeat(3000)}</a:r></a:p>`));
    expect(breaks.isTruncated).toBe(true);
    expect((breaks.content.match(/<br>/g) || []).length).toBeLessThan(MAX_DOCUMENT_PREVIEW_LINES);
  });

  test('Keeps Markdown code literal and permits only safe absolute link protocols', () => {
    const html = parseMarkdownPreview('```js\n**text** [x](javascript:alert)\n```\n'
      + '[safe](https://example.com/path?q=1&x=2) [unsafe](javascript:alert)\n<script>');
    expect(html).toContain('<pre><code>**text** [x](javascript:alert)</code></pre>');
    expect(html).toContain('href="https://example.com/path?q=1&amp;x=2"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<script>');
  });

  test('Search highlights text nodes while preserving formatting and link attributes', () => {
    const html = '<p><strong>Строка</strong> и строка <a href="https://example.com/Строка">ссылка</a></p>';
    const result = highlightDocumentHtml(html, 'Строка', 'search-mark');
    expect(result.count).toBe(2);
    expect(result.content).toContain('<strong><mark class="search-mark">Строка</mark></strong>');
    expect(result.content).toContain('href="https://example.com/Строка"');
    expect(highlightDocumentHtml('<p>a+b a+b</p>', 'a+b', 'search-mark').count).toBe(2);
  });

  test('Bounds highlight DOM even for an excessively common query', () => {
    const result = highlightDocumentHtml(`<p>${'a '.repeat(10000)}</p>`, 'a', 'search-mark');
    expect(result.count).toBe(MAX_DOCUMENT_SEARCH_MATCHES);
    expect((result.content.match(/<mark/g) || []).length).toBe(MAX_DOCUMENT_SEARCH_MATCHES);
  });
});
