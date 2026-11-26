import { getActions, getGlobal } from '../../global';

import type { ActiveDownloads } from '../../types';
import { ApiMediaFormat, MAIN_THREAD_ID, MESSAGE_DELETED } from '../../api/types';

import {
  getMainUsername, getMediaHash, getMessageLink, isChatChannel, isChatSuperGroup,
} from '../../global/helpers';
import {
  selectAllowedMessageActionsSlow, selectChat, selectIsMessageProtected, selectTabState,
} from '../../global/selectors';
import { selectMessageDownloadableMedia } from '../../global/selectors/media';
import { callApi } from '../../api/gramjs';

const MIN_SIZE = 32 * 1024 * 1024;
const MAX_SIZE = 4096 * 1024 * 1024;
const MAX_RESUMING = 3;

type Request = { id: string; chatId: string; messageId: number; mediaHash: string };
type QueueAction = { type: 'list' } | { type: 'remember'; request: Request }
  | { type: 'associate'; id: string; operationId: string } | { type: 'forget'; id: string };
type Metadata = ActiveDownloads[string];

export function buildRecoveryRequest(mediaHash: string, metadata: Metadata): Request | undefined {
  const { size, format, originChatId, originMessageId, downloadRecoveryId } = metadata;
  if (size < MIN_SIZE || size > MAX_SIZE || format !== ApiMediaFormat.BlobUrl
    || !originChatId || !originMessageId || !/^document-?\d{1,19}(?:\?download)?$/.test(mediaHash)) return undefined;
  return { id: downloadRecoveryId || crypto.randomUUID(), chatId: originChatId, messageId: originMessageId, mediaHash };
}

export function getPublicDownloadSource(metadata: Metadata) {
  const { originChatId, originMessageId } = metadata;
  if (!originChatId || !originMessageId) return undefined;
  const chat = selectChat(getGlobal(), originChatId);
  if (!chat || !(isChatChannel(chat) || isChatSuperGroup(chat)) || !getMainUsername(chat)) return undefined;
  return getMessageLink(chat, undefined, originMessageId);
}

export async function changeTelegramDownloadQueue(accountId: string, action: QueueAction) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<Request[]>('relay_telegram_download_queue', { accountId, action });
}

export async function restoreTelegramDownloadQueue(accountId: string, attempted: Set<string>, signal: AbortSignal) {
  if (!isCurrentAccount(accountId, signal)) return;
  const active = selectTabState(getGlobal()).activeDownloads;
  let slots = MAX_RESUMING - Object.keys(active).length;
  if (slots <= 0) return;
  const queue = await changeTelegramDownloadQueue(accountId, { type: 'list' });
  for (const request of queue) {
    if (slots <= 0 || !isCurrentAccount(accountId, signal)) break;
    if (attempted.has(request.id) || selectTabState(getGlobal()).activeDownloads[request.mediaHash]) continue;
    if (await restoreOne(accountId, request, attempted, signal)) slots--;
  }
}

async function restoreOne(accountId: string, request: Request, attempted: Set<string>, signal: AbortSignal) {
  const chat = selectChat(getGlobal(), request.chatId);
  if (!chat) return false;
  const result = await callApi('fetchMessage', { chat, messageId: request.messageId, isSilent: true })
    .catch(() => undefined);
  if (!result || !isCurrentAccount(accountId, signal)) return false;
  attempted.add(request.id);

  if (result === MESSAGE_DELETED) {
    await changeTelegramDownloadQueue(accountId, { type: 'forget', id: request.id });
    return false;
  }
  const { message } = result;
  if (message.chatId !== request.chatId || message.id !== request.messageId) return false;
  const global = getGlobal();
  const media = selectMessageDownloadableMedia(global, message);
  if (!media || getMediaHash(media, 'download') !== request.mediaHash
    || selectIsMessageProtected(global, message)
    || !selectAllowedMessageActionsSlow(global, message, MAIN_THREAD_ID).canDownload) {
    await changeTelegramDownloadQueue(accountId, { type: 'forget', id: request.id });
    return false;
  }
  if (selectTabState(global).activeDownloads[request.mediaHash]) return false;
  getActions().downloadMedia({ media, originMessage: message, downloadRecoveryId: request.id });
  return true;
}

function isCurrentAccount(accountId: string, signal: AbortSignal) {
  const global = getGlobal();
  return !signal.aborted && global.currentUserId === accountId && !global.passcode?.isScreenLocked;
}
