import type MTProtoSender from '../network/MTProtoSender';
import type TelegramClient from './TelegramClient';

import { bufferToHex, compareBuffersConstantTime } from '../../../util/encoding/buffer';
import { createDecipheriv } from '../crypto/crypto';
import Api from '../tl/api';
import { requestCdnFile } from './telegramCdn';

import { sha256 } from '../Helpers';

const BLOCK_SIZE = 1024 * 1024;
const MIN_PART = 4096;
const MAX_CACHED_BLOCKS = 8;
const verifiedBlocks = new WeakMap<TelegramClient, Map<string, Uint8Array>>();

export async function downloadCdnRange(
  client: TelegramClient, master: MTProtoSender, redirect: Api.upload.FileCdnRedirect,
  offset: number, length: number, fileSize: number | undefined, signal: AbortSignal,
  isResearchRequest?: boolean,
) {
  const { dcId, fileToken, encryptionKey, encryptionIv } = redirect;
  if (encryptionKey.length !== 32 || encryptionIv.length !== 16 || !fileToken.length) {
    throw new Error('MEDIA_CDN_INVALID_REDIRECT');
  }

  const hashes = [...redirect.fileHashes];
  const cache = fileSize === undefined ? undefined : getVerifiedBlockCache(client);
  const end = Math.min(offset + length, fileSize ?? Infinity);
  const result = new Uint8Array(end - offset);
  let position = offset;
  const findHash = (at: number) => hashes.find((hash) => hash.offset <= BigInt(at)
    && BigInt(at) < hash.offset + BigInt(hash.limit));

  while (position < end) {
    signal.throwIfAborted();
    let hash = findHash(position);
    if (!hash) {
      const more = await master.send(new Api.upload.GetCdnFileHashes({
        fileToken, offset: BigInt(position),
      }), signal, false, isResearchRequest);
      if (!more?.length) throw new Error('MEDIA_CDN_HASH_MISSING');
      hashes.push(...more);
      hash = findHash(position);
    }
    if (!hash) throw new Error('MEDIA_CDN_HASH_MISSING');
    const start = Number(hash.offset);
    const expectedBytes = Math.min(hash.limit, (fileSize ?? Infinity) - start);
    if (!Number.isSafeInteger(start) || start < 0 || start % MIN_PART !== 0 || start / 16 > 0xffffffff
      || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > BLOCK_SIZE
      || hash.hash.length !== 32) {
      throw new Error('MEDIA_CDN_INVALID_HASH');
    }
    // Telegram требует размер части, делящий 1 МиБ, и диапазон в пределах одного блока 1 МиБ.
    const limit = Math.max(MIN_PART, 2 ** Math.ceil(Math.log2(expectedBytes)));
    if ((start % BLOCK_SIZE) + limit > BLOCK_SIZE) throw new Error('MEDIA_CDN_INVALID_HASH');
    const cacheKey = `${expectedBytes}:${bufferToHex(hash.hash)}`;
    let plaintext = cache?.get(cacheKey);
    let isShortBlock = false;
    if (!plaintext) {
      const request = new Api.upload.GetCdnFile({ fileToken, offset: hash.offset, limit });
      let chunk = await requestCdnFile(client, dcId, request, signal);
      if (chunk instanceof Api.upload.CdnFileReuploadNeeded) {
        await master.send(new Api.upload.ReuploadCdnFile({
          fileToken, requestToken: chunk.requestToken,
        }), signal, false, isResearchRequest);
        chunk = await requestCdnFile(client, dcId, request, signal);
      }
      if (!(chunk instanceof Api.upload.CdnFile) || chunk.bytes.length < expectedBytes || chunk.bytes.length > limit) {
        throw new Error('MEDIA_CDN_INCOMPLETE');
      }
      const iv = encryptionIv.slice();
      new DataView(iv.buffer, iv.byteOffset, iv.byteLength).setUint32(12, start / 16);
      plaintext = createDecipheriv('AES-256-CTR', encryptionKey, iv).update(chunk.bytes.subarray(0, expectedBytes));
      if (!compareBuffersConstantTime(await sha256(plaintext), hash.hash)) throw new Error('CDN_FILE_TAMPERED');
      signal.throwIfAborted();
      isShortBlock = chunk.bytes.length === plaintext.length && chunk.bytes.length < limit;
    }
    if (cache) {
      cache.delete(cacheKey);
      cache.set(cacheKey, plaintext);
      if (cache.size > MAX_CACHED_BLOCKS) cache.delete(cache.keys().next().value!);
    }
    const next = Math.min(end, start + plaintext.length);
    result.set(plaintext.subarray(position - start, next - start), position - offset);
    position = next;
    if (fileSize === undefined && isShortBlock) break;
  }
  return result.subarray(0, position - offset);
}

function getVerifiedBlockCache(client: TelegramClient) {
  const existing = verifiedBlocks.get(client);
  if (existing) return existing;
  const cache = new Map<string, Uint8Array>();
  verifiedBlocks.set(client, cache);
  return cache;
}
