import { Inflate } from 'fflate';

import { READABLE_EXTENSIONS } from './documentReaderState';

export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_DOCX_PREVIEW_BYTES = 4 * 1024 * 1024;
export const MAX_PDF_PREVIEW_BYTES = 32 * 1024 * 1024;
export const MAX_DOCUMENT_PREVIEW_CHARS = 100000;
export const MAX_DOCUMENT_PREVIEW_LINES = 2000;
export const MAX_DOCUMENT_SEARCH_MATCHES = 2000;
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MAX_DOCX_PREVIEW_RUNS = 4000;
const MAX_DOCX_ARCHIVE_ENTRIES = 1024;

export type DocumentPreviewErrorCode = 'unavailable' | 'tooLarge' | 'invalidDocx';
export type DocumentPreview = { content: string; isTruncated: boolean };

export class DocumentPreviewError extends Error {
  constructor(public code: DocumentPreviewErrorCode) {
    super(code);
  }
}

export function isTextDocumentExtension(extension: string) {
  return READABLE_EXTENSIONS.has(extension) && !['pdf', 'docx', 'md', 'markdown'].includes(extension);
}

export function getDocumentPreviewLimit(extension: string) {
  return extension === 'pdf' ? MAX_PDF_PREVIEW_BYTES
    : extension === 'docx' ? MAX_DOCX_PREVIEW_BYTES : MAX_TEXT_PREVIEW_BYTES;
}

export async function readDocumentPreviewBytes(url: string, limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(url, { signal });
  if (!response.ok) throw new DocumentPreviewError('unavailable');
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > limit) {
    await response.body?.cancel();
    throw new DocumentPreviewError('tooLarge');
  }
  if (!response.body) throw new DocumentPreviewError('unavailable');

  const reader = response.body.getReader();
  const handleAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', handleAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new DocumentPreviewError('tooLarge');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', handleAbort);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return bytes;
}

export function limitDocumentPreview(content: string): DocumentPreview {
  const clipped = content.slice(0, MAX_DOCUMENT_PREVIEW_CHARS);
  const lines = clipped.split('\n');
  return {
    content: lines.slice(0, MAX_DOCUMENT_PREVIEW_LINES).join('\n'),
    isTruncated: content.length > clipped.length || lines.length > MAX_DOCUMENT_PREVIEW_LINES,
  };
}

export function decodeDocumentPreviewText(bytes: Uint8Array) {
  const encoding = bytes[0] === 0xFF && bytes[1] === 0xFE ? 'utf-16le'
    : bytes[0] === 0xFE && bytes[1] === 0xFF ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

export function parseDocxPreview(bytes: Uint8Array): DocumentPreview {
  try {
    const xmlBytes = readDocxDocumentXml(bytes);
    const xml = new DOMParser().parseFromString(decodeDocumentPreviewText(xmlBytes), 'application/xml');
    if (xml.querySelector('parsererror')) throw new DocumentPreviewError('invalidDocx');
    const body = xml.getElementsByTagNameNS(WORD_NAMESPACE, 'body')[0];
    if (!body) throw new DocumentPreviewError('invalidDocx');

    let content = '';
    let characterCount = 0;
    let runCount = 0;
    let lineCount = 0;
    let isTruncated = false;
    const paragraphs = body.getElementsByTagNameNS(WORD_NAMESPACE, 'p');
    for (let index = 0; index < paragraphs.length; index++) {
      if (lineCount >= MAX_DOCUMENT_PREVIEW_LINES || characterCount >= MAX_DOCUMENT_PREVIEW_CHARS
        || runCount >= MAX_DOCX_PREVIEW_RUNS) {
        isTruncated = true;
        break;
      }
      const paragraph = paragraphs[index];
      lineCount++;
      let paragraphHtml = '';
      const runs = paragraph.getElementsByTagNameNS(WORD_NAMESPACE, 'r');
      for (const run of Array.from(runs)) {
        if (runCount >= MAX_DOCX_PREVIEW_RUNS || lineCount >= MAX_DOCUMENT_PREVIEW_LINES) {
          isTruncated = true;
          break;
        }
        runCount++;
        let runText = '';
        for (const child of Array.from(run.children)) {
          if (child.namespaceURI !== WORD_NAMESPACE) continue;
          if (child.localName === 't') runText += child.textContent || '';
          if (child.localName === 'br') {
            lineCount++;
            if (lineCount >= MAX_DOCUMENT_PREVIEW_LINES) {
              isTruncated = true;
              break;
            }
            runText += '\n';
          }
          if (child.localName === 'tab') runText += '\t';
        }
        const remaining = MAX_DOCUMENT_PREVIEW_CHARS - characterCount;
        if (runText.length > remaining) isTruncated = true;
        runText = runText.slice(0, remaining);
        characterCount += runText.length;
        let runHtml = escapeDocumentText(runText).replace(/\n/g, '<br>');
        if (getHasWordFormat(run, 'b')) runHtml = `<strong>${runHtml}</strong>`;
        if (getHasWordFormat(run, 'i')) runHtml = `<em>${runHtml}</em>`;
        if (getHasWordFormat(run, 'u')) runHtml = `<u>${runHtml}</u>`;
        paragraphHtml += runHtml;
        if (characterCount >= MAX_DOCUMENT_PREVIEW_CHARS) break;
      }
      const style = paragraph.getElementsByTagNameNS(WORD_NAMESPACE, 'pStyle')[0]
        ?.getAttributeNS(WORD_NAMESPACE, 'val')?.toLowerCase();
      const heading = style?.match(/^heading([1-6])$/)?.[1];
      const tag = heading ? `h${heading}` : 'p';
      if (paragraphHtml.trim()) content += `<${tag}>${paragraphHtml}</${tag}>`;
    }
    return { content, isTruncated };
  } catch (err) {
    if (err instanceof DocumentPreviewError) throw err;
    throw new DocumentPreviewError('invalidDocx');
  }
}

function readDocxDocumentXml(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_DOCX_PREVIEW_BYTES) throw new DocumentPreviewError('tooLarge');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  const minimumEnd = Math.max(0, end - 65535);
  while (end >= minimumEnd && (view.getUint32(end, true) !== 0x06054B50
    || end + 22 + view.getUint16(end + 20, true) !== bytes.byteLength)) end--;
  if (end < minimumEnd) throw new DocumentPreviewError('invalidDocx');
  const entryCount = view.getUint16(end + 10, true);
  if (entryCount > MAX_DOCX_ARCHIVE_ENTRIES) throw new DocumentPreviewError('tooLarge');
  const centralStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
    || view.getUint16(end + 8, true) !== entryCount
    || centralStart + view.getUint32(end + 12, true) !== end) {
    throw new DocumentPreviewError('invalidDocx');
  }
  let offset = centralStart;
  let documentEntry: { offset: number; originalSize: number; compressedSize: number; method: number; flags: number }
    | undefined;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014B50) {
      throw new DocumentPreviewError('invalidDocx');
    }
    const nameLength = view.getUint16(offset + 28, true);
    const nextOffset = offset + 46 + nameLength + view.getUint16(offset + 30, true)
      + view.getUint16(offset + 32, true);
    if (nextOffset > end) throw new DocumentPreviewError('invalidDocx');
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name === 'word/document.xml') {
      if (documentEntry) throw new DocumentPreviewError('invalidDocx');
      documentEntry = {
        offset: view.getUint32(offset + 42, true), originalSize: view.getUint32(offset + 24, true),
        compressedSize: view.getUint32(offset + 20, true), method: view.getUint16(offset + 10, true),
        flags: view.getUint16(offset + 8, true),
      };
      if (documentEntry.originalSize > MAX_DOCX_PREVIEW_BYTES) throw new DocumentPreviewError('tooLarge');
      if (view.getUint16(offset + 34, true) || documentEntry.flags & 1
        || ![0, 8].includes(documentEntry.method)) throw new DocumentPreviewError('invalidDocx');
    }
    offset = nextOffset;
  }
  if (offset !== end || !documentEntry) throw new DocumentPreviewError('invalidDocx');
  const local = documentEntry.offset;
  if (local + 30 > centralStart || view.getUint32(local, true) !== 0x04034B50
    || view.getUint16(local + 8, true) !== documentEntry.method
    || view.getUint16(local + 6, true) !== documentEntry.flags) throw new DocumentPreviewError('invalidDocx');
  const nameLength = view.getUint16(local + 26, true);
  const dataStart = local + 30 + nameLength + view.getUint16(local + 28, true);
  if (dataStart + documentEntry.compressedSize > centralStart
    || new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + nameLength)) !== 'word/document.xml') {
    throw new DocumentPreviewError('invalidDocx');
  }
  const compressed = bytes.subarray(dataStart, dataStart + documentEntry.compressedSize);
  if (documentEntry.method === 0) {
    if (compressed.byteLength !== documentEntry.originalSize) throw new DocumentPreviewError('invalidDocx');
    return compressed;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.byteLength;
    if (total > MAX_DOCX_PREVIEW_BYTES) throw new DocumentPreviewError('tooLarge');
    chunks.push(chunk);
  });
  // Small compressed chunks bound work before the observed output limit, even with a forged ZIP size.
  for (let start = 0; start < compressed.byteLength; start += 1024) {
    const next = Math.min(start + 1024, compressed.byteLength);
    inflater.push(compressed.subarray(start, next), next === compressed.byteLength);
  }
  if (total !== documentEntry.originalSize) throw new DocumentPreviewError('invalidDocx');
  const result = new Uint8Array(total);
  let resultOffset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, resultOffset);
    resultOffset += chunk.byteLength;
  });
  return result;
}

function getHasWordFormat(run: Element, name: string) {
  const format = run.getElementsByTagNameNS(WORD_NAMESPACE, name)[0];
  return Boolean(format) && !['0', 'false', 'off', 'none'].includes(
    format.getAttributeNS(WORD_NAMESPACE, 'val') || '',
  );
}

export function parseMarkdownPreview(content: string) {
  const lines = content.split('\n');
  const html: string[] = [];
  let codeLines: string[] | undefined;
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (codeLines) {
        html.push(`<pre><code>${escapeDocumentText(codeLines.join('\n'))}</code></pre>`);
        codeLines = undefined;
      } else {
        codeLines = [];
      }
    } else if (codeLines) {
      codeLines.push(line);
    } else {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      const quote = line.match(/^>\s?(.*)$/);
      const list = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
      if (heading) html.push(`<h${heading[1].length}>${formatDocumentInline(heading[2])}</h${heading[1].length}>`);
      else if (quote) html.push(`<blockquote>${formatDocumentInline(quote[1])}</blockquote>`);
      else if (list) html.push(`<ul><li>${formatDocumentInline(list[1])}</li></ul>`);
      else if (line.trim()) html.push(`<p>${formatDocumentInline(line)}</p>`);
    }
  }
  if (codeLines) html.push(`<pre><code>${escapeDocumentText(codeLines.join('\n'))}</code></pre>`);
  return html.join('');
}

function formatDocumentInline(text: string) {
  const tokens: string[] = [];
  const escaped = escapeDocumentText(text).replace(/`([^`]+)`/g, (_, code: string) => {
    tokens.push(`<code>${code}</code>`);
    return `\uE000${tokens.length - 1}\uE001`;
  }).replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => {
    try {
      const url = new URL(href.replace(/&amp;/g, '&'));
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return label;
      tokens.push(`<a href="${escapeDocumentText(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
      return `\uE000${tokens.length - 1}\uE001`;
    } catch {
      return label;
    }
  }).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return escaped.replace(/\uE000(\d+)\uE001/g, (_, index: string) => tokens[Number(index)] || '');
}

export function highlightDocumentHtml(content: string, query: string, className: string) {
  if (!query.trim()) return { content, count: 0 };
  const parsed = new DOMParser().parseFromString(content, 'text/html');
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const pattern = buildDocumentSearchPattern(query);
  let count = 0;
  for (const node of nodes) {
    const text = node.textContent || '';
    const fragments = parsed.createDocumentFragment();
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      if (count >= MAX_DOCUMENT_SEARCH_MATCHES) break;
      const index = match.index;
      fragments.append(text.slice(offset, index));
      const mark = parsed.createElement('mark');
      mark.className = className;
      mark.textContent = match[0];
      fragments.append(mark);
      offset = index + match[0].length;
      count++;
    }
    if (offset) {
      fragments.append(text.slice(offset));
      node.replaceWith(fragments);
    }
  }
  return { content: parsed.body.innerHTML, count };
}

export function buildDocumentSearchPattern(query: string) {
  return new RegExp(query.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
}

function escapeDocumentText(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
