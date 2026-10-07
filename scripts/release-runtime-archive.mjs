import { assertSafeRelative, requireCondition } from './release-policy.mjs';

export async function readBoundedBody(body, limit, contentLength) {
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number(contentLength);
    requireCondition(Number.isSafeInteger(declared) && declared >= 0 && declared <= limit,
      'Runtime archive exceeds download limit');
  }
  requireCondition(body, 'Runtime download has no response body');
  let received = 0; const chunks = [];
  for await (const chunk of body) {
    received += chunk.byteLength;
    requireCondition(received <= limit, 'Runtime archive exceeds streaming download limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, received);
}

export function validateArchiveEntry(entry, expected, seen) {
  assertSafeRelative(entry.name);
  const file = expected.get(entry.name);
  requireCondition(file && entry.originalSize === file.bytes && !seen.has(entry.name),
    `Runtime archive metadata rejected: ${entry.name}`);
  seen.add(entry.name);
  return true;
}
