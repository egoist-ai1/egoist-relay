import { addCallback, removeCallback } from '../../lib/teact/teactn';
import { getGlobal } from '../../global';

import type { ApiAttachment, ApiMessage, ApiOnProgress } from '../../api/types';
import type { ThreadId } from '../../types';
import type { SavedMedia } from './mediaOperations.types';
import { MAIN_THREAD_ID } from '../../api/types';

import { getPeerStarsForMessage } from '../../global/actions/api/messages';
import {
  getAllowedAttachmentOptions, getCanPostInChat, isDeletedUser, isSystemBot,
} from '../../global/helpers';
import {
  selectChat, selectChatFullInfo, selectIsChatRestricted, selectTopic, selectUser,
} from '../../global/selectors';
import { parseInlineSocialMediaUrl } from '../../util/inlineSocialMedia';
import { callApi } from '../../api/gramjs';
import buildAttachment from '../middle/composer/helpers/buildAttachment';

export type SocialShareRequest = {
  requestId: string;
  service: 'x' | 'instagram';
  url: string;
  text?: string;
  media?: { url: string; type: 'photo' | 'video' }[];
  unavailableMedia?: boolean;
};

export type SocialShareTarget = { peerId: string; threadId?: ThreadId };
export type SocialShareMode = 'link' | 'media' | 'file';
export type SocialShareSuccess = { recipientName: string; count: number };
export type SocialMediaProgress = {
  requestId: string;
  index: number;
  state: 'fetching' | 'ready' | 'error';
  loaded: number;
  total?: number;
};
export type ShareSendItem = { randomId: string; text?: string; attachment?: ApiAttachment; localMessage?: ApiMessage };
export type ShareSendJob = { target: SocialShareTarget; items: ShareSendItem[]; confirmed: number; busy: boolean };

const MAX_FILE_SIZE = 64 * 1024 * 1024;
const MAX_TOTAL_SIZE = 128 * 1024 * 1024;
const MEDIA_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);

export function isSocialShareRequest(value: unknown): value is SocialShareRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as SocialShareRequest;
  if (!/^[a-z0-9-]{16,64}$/i.test(request.requestId) || !['x', 'instagram'].includes(request.service)) return false;
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (parseInlineSocialMediaUrl(request.url)?.provider !== request.service) return false;
  } catch {
    return false;
  }
  return (request.unavailableMedia === undefined || typeof request.unavailableMedia === 'boolean')
    && (request.text === undefined || (typeof request.text === 'string' && request.text.length <= 4096))
    && (request.media === undefined || (Array.isArray(request.media) && request.media.length <= 10
      && request.media.every((media) => media && typeof media === 'object'
        && ['photo', 'video'].includes(media.type) && typeof media.url === 'string')));
}

export function getSocialShareMediaCount(request: SocialShareRequest): number {
  return request.unavailableMedia ? 1 : request.media?.length || 0;
}

export function parseSocialMediaPacket(packet: ArrayBuffer, expectedIndex: number): File {
  if (!(packet instanceof ArrayBuffer) || packet.byteLength < 9) throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
  const bytes = new Uint8Array(packet);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'ERMS') throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
  const headerSize = new DataView(packet).getUint32(4, true);
  if (!headerSize || headerSize > 1024 || headerSize + 8 >= bytes.length) throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
  const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + headerSize)));
  if (header.index !== expectedIndex || !Number.isInteger(header.size) || header.size <= 0
    || header.size > MAX_FILE_SIZE || header.size !== bytes.length - 8 - headerSize
    || typeof header.name !== 'string' || !header.name || header.name.length > 96
    || !/^[a-z0-9.-]+$/i.test(header.name) || header.name.includes('..')
    || !MEDIA_MIME_TYPES.has(header.mimeType)) {
    throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
  }
  return new File([packet.slice(8 + headerSize)], header.name, { type: header.mimeType });
}

export async function resolveSocialShareMedia(
  request: SocialShareRequest,
  isCanceled: () => boolean,
  onProgress: (index: number) => void,
): Promise<ApiAttachment[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  const attachments: ApiAttachment[] = [];
  const mediaCount = getSocialShareMediaCount(request);
  if (!mediaCount) throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
  let totalSize = 0;
  try {
    for (let index = 0; index < mediaCount; index++) {
      if (isCanceled()) throw new Error('SOCIAL_SHARE_CANCELED');
      onProgress(index);
      const packet = await invoke<ArrayBuffer>('multi_social_read_media', { requestId: request.requestId, index });
      if (isCanceled()) throw new Error('SOCIAL_SHARE_CANCELED');
      const file = parseSocialMediaPacket(packet, index);
      if (request.unavailableMedia && !file.type.startsWith('video/')) throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
      totalSize += file.size;
      if (totalSize > MAX_TOTAL_SIZE) throw new Error('SOCIAL_SHARE_MEDIA_TOO_LARGE');
      const createdUrls = new Set<string>();
      try {
        const attachment = await buildAttachment(file.name, file, undefined, (url) => createdUrls.add(url));
        attachments.push(attachment);
      } catch (error) {
        createdUrls.forEach((url) => URL.revokeObjectURL(url));
        throw error;
      }
      if (isCanceled()) throw new Error('SOCIAL_SHARE_CANCELED');
    }
    return attachments;
  } catch (error) {
    releaseSocialShareMedia(attachments);
    throw error;
  }
}

export async function saveSocialShareMedia(
  request: SocialShareRequest, isCanceled: () => boolean, onProgress: (index: number) => void,
): Promise<SavedMedia[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  const mediaCount = getSocialShareMediaCount(request);
  if (!mediaCount) throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
  const saved: SavedMedia[] = [];
  for (let index = 0; index < mediaCount; index++) {
    if (isCanceled()) throw new Error('SOCIAL_SHARE_CANCELED');
    onProgress(index);
    const file = await invoke<SavedMedia>('multi_social_save_media', { requestId: request.requestId, index });
    saved.push(file);
    if (isCanceled()) throw new Error('SOCIAL_SHARE_CANCELED');
  }
  return saved;
}

export function releaseSocialShareMedia(attachments: ApiAttachment[]) {
  const urls = new Set(attachments.flatMap((attachment) => (
    [attachment.blobUrl, attachment.compressedBlobUrl, attachment.previewBlobUrl]
  )));
  urls.forEach((url) => {
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
  });
  attachments.length = 0;
}

export function getSocialShareTextParts(request: SocialShareRequest): string[] {
  const text = request.text?.trim();
  const content = text ? `${text}\n\n${request.url}` : request.url;
  const limit = Math.max(1, getGlobal().config?.maxMessageLength || 4096);
  const parts: string[] = [];
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(content.length, offset + limit);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    if (end === offset) throw new Error('SOCIAL_SHARE_INVALID_TEXT_LIMIT');
    parts.push(content.slice(offset, end));
    offset = end;
  }
  return parts;
}

export function assertSocialShareTarget(target: SocialShareTarget, attachments: ApiAttachment[] = []) {
  const global = getGlobal();
  const chat = selectChat(global, target.peerId);
  const user = selectUser(global, target.peerId);
  const fullInfo = selectChatFullInfo(global, target.peerId);
  const topic = target.threadId ? selectTopic(global, target.peerId, target.threadId) : undefined;
  if (!chat || isSystemBot(target.peerId) || (user && isDeletedUser(user))
    || selectIsChatRestricted(global, target.peerId) || (chat.isForum && !topic)
    || !getCanPostInChat(chat, topic, false, fullInfo)) throw new Error('SOCIAL_SHARE_RECIPIENT_RESTRICTED');
  const permissions = getAllowedAttachmentOptions(chat, fullInfo);
  if (!permissions.canSendPlainText || attachments.some((attachment) => (
    !permissions.canAttachMedia || (attachment.shouldSendAsFile ? !permissions.canSendDocuments
      : attachment.mimeType.startsWith('image/') ? !permissions.canSendPhotos : !permissions.canSendVideos)
  ))) throw new Error('SOCIAL_SHARE_RECIPIENT_RESTRICTED');
  return chat;
}

export async function getSocialSharePrice(target: SocialShareTarget): Promise<number> {
  if (!selectChat(getGlobal(), target.peerId)) {
    const user = selectUser(getGlobal(), target.peerId);
    if (!user || isDeletedUser(user) || isSystemBot(target.peerId)) {
      throw new Error('SOCIAL_SHARE_RECIPIENT_RESTRICTED');
    }
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!selectChat(getGlobal(), target.peerId)) return;
        clearTimeout(timeout);
        removeCallback(check);
        resolve();
      };
      const timeout = setTimeout(() => {
        removeCallback(check);
        reject(new Error('SOCIAL_SHARE_RECIPIENT_UNAVAILABLE'));
      }, 10000);
      addCallback(check);
      void callApi('fetchChat', { type: 'user', user }).then((result) => {
        if (result) check();
        else {
          clearTimeout(timeout);
          removeCallback(check);
          reject(new Error('SOCIAL_SHARE_RECIPIENT_UNAVAILABLE'));
        }
      }).catch((error) => {
        clearTimeout(timeout);
        removeCallback(check);
        reject(error);
      });
    });
  }
  assertSocialShareTarget(target);
  const global = getGlobal();
  const user = selectUser(global, target.peerId);
  const price = await getPeerStarsForMessage(global, target.peerId);
  if (user?.paidMessagesStars && price === undefined) throw new Error('SOCIAL_SHARE_PRICE_UNAVAILABLE');
  return price || 0;
}

export function createSocialShareJob(
  request: SocialShareRequest, target: SocialShareTarget, attachments: ApiAttachment[], mode: SocialShareMode = 'media',
): ShareSendJob {
  const randomId = () => {
    const value = crypto.getRandomValues(new Uint32Array(2));
    return BigInt.asIntN(64, (BigInt(value[0]) << 32n) | BigInt(value[1])).toString();
  };
  return {
    target: { ...target }, confirmed: 0, busy: false,
    items: [
      ...getSocialShareTextParts(request).map((text) => ({ text, randomId: randomId() })),
      ...attachments.map((attachment) => ({
        attachment: mode === 'file' ? { ...attachment, shouldSendAsFile: true as const } : attachment,
        randomId: randomId(),
      })),
    ],
  };
}

export async function sendSocialShareJob(
  job: ShareSendJob, price: number, onProgress: (confirmed: number, progress?: number) => void,
  lifecycle: { isCanceled?: () => boolean; onBeforeSend?: () => Promise<void>;
    onConfirmed?: (confirmed: number) => Promise<void>; onDispatch?: NoneToVoidFunction; } = {},
): Promise<void> {
  if (job.busy) throw new Error('SOCIAL_SHARE_BUSY');
  job.busy = true;
  try {
    for (; job.confirmed < job.items.length;) {
      if (lifecycle.isCanceled?.()) throw new Error('SOCIAL_SHARE_CANCELED');
      const item = job.items[job.confirmed];
      const chat = assertSocialShareTarget(job.target, item.attachment ? [item.attachment] : []);
      const params = {
        chat, text: item.text, attachment: item.attachment,
        replyInfo: job.target.threadId && job.target.threadId !== MAIN_THREAD_ID ? {
          type: 'message' as const,
          replyToMsgId: Number(job.target.threadId),
          replyToTopId: Number(job.target.threadId),
        } : undefined,
        messagePriceInStars: price || undefined,
        socialShareRandomId: item.randomId,
        shouldThrowOnSendError: true,
        shouldPreserveDraft: true,
        shouldSkipFocus: true,
      };
      await lifecycle.onBeforeSend?.();
      if (lifecycle.isCanceled?.()) throw new Error('SOCIAL_SHARE_CANCELED');
      item.localMessage ||= await callApi('sendMessageLocal', params);
      if (!item.localMessage) throw new Error('SOCIAL_SHARE_UNCONFIRMED');
      if (lifecycle.isCanceled?.()) throw new Error('SOCIAL_SHARE_CANCELED');
      const progress: ApiOnProgress = (value) => onProgress(job.confirmed, value);
      lifecycle.onDispatch?.();
      const confirmed = await callApi('sendMessage', { ...params, localMessage: item.localMessage }, progress);
      if (confirmed !== true) throw new Error('SOCIAL_SHARE_UNCONFIRMED');
      job.confirmed++;
      await lifecycle.onConfirmed?.(job.confirmed);
      onProgress(job.confirmed);
    }
  } finally {
    job.busy = false;
  }
}

export async function getSocialShareFingerprints(job: ShareSendJob): Promise<string[]> {
  const results: string[] = [];
  for (const item of job.items) {
    if (item.attachment && !item.attachment.blob) throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
    const bytes = item.attachment ? await item.attachment.blob!.arrayBuffer()
      : new TextEncoder().encode(item.text || '').buffer;
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    results.push(Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''));
  }
  return results;
}
