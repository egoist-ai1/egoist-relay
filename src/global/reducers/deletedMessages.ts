import type { ApiMessage } from '../../api/types';
import type { GlobalState, TabArgs } from '../types';
import { MAIN_THREAD_ID } from '../../api/types';

import {
  applyDeletedRecordToMessage,
  buildDeletedRecord,
  canKeepDeletedMessage,
  type DeletedMessageRecord,
} from '../../util/deletedMessages';
import { getCurrentTabId } from '../../util/establishMultitabRole';
import { isInsideSortedArrayRange } from '../../util/iteratees';
import {
  selectChat,
  selectChatLastMessageId,
  selectChatMessage,
  selectChatMessages,
  selectCommonBoxChatId,
  selectListedIds,
  selectOutlyingLists,
  selectViewportIds,
} from '../selectors';
import {
  addChatMessagesById,
  deleteChatMessages,
  safeReplaceViewportIds,
  updateChatMessage,
  updateListedIds,
  updateOutlyingLists,
} from './messages';

// Marks loaded messages as kept after deletion and builds the records to persist
export function keepDeletedMessages<T extends GlobalState>(
  global: T,
  chatId: string | undefined,
  ids: number[],
  options: { deletedAt: number; isDeletedByMe?: boolean },
) {
  const { deletedAt, isDeletedByMe } = options;
  const userId = global.currentUserId;
  const keptIds = new Set<number>();
  const records: DeletedMessageRecord[] = [];
  if (!userId) return { global, keptIds, records };

  ids.forEach((id) => {
    const messageChatId = chatId || selectCommonBoxChatId(global, id);
    if (!messageChatId) return;

    const chat = selectChat(global, messageChatId);
    const message = selectChatMessage(global, messageChatId, id);
    if (!message) {
      // Only a loaded chat gets a placeholder for a message that was never loaded
      const isChatLoaded = chatId && selectChatMessages(global, chatId) && chat?.type !== 'chatTypeSecret';
      if (isChatLoaded) {
        records.push(buildDeletedRecord({
          userId, chatId: messageChatId, id, deletedAt, isDeletedByMe,
        }));
      }
      return;
    }

    if (message.deletedAt) {
      keptIds.add(id);
      return;
    }
    if (!canKeepDeletedMessage(message, chat)) return;

    records.push(buildDeletedRecord({
      userId, chatId: messageChatId, id, deletedAt, message, isDeletedByMe,
    }));
    global = updateChatMessage(global, messageChatId, id, {
      deletedAt,
      isDeleting: undefined,
      groupedId: undefined,
      isInAlbum: undefined,
    });
    keptIds.add(id);
  });

  return { global, keptIds, records };
}

// Puts saved copies of deleted messages back into the lists of an already loaded chat history
export function restoreDeletedMessages<T extends GlobalState>(
  global: T,
  chatId: string,
  records: DeletedMessageRecord[],
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): T {
  const chat = selectChat(global, chatId);
  if (!chat || chat.isForum) return global;

  const byId = selectChatMessages(global, chatId);
  const listedIds = selectListedIds(global, chatId, MAIN_THREAD_ID);
  const outlyingLists = selectOutlyingLists(global, chatId, MAIN_THREAD_ID) || [];
  const viewportIds = selectViewportIds(global, chatId, MAIN_THREAD_ID, tabId);
  if (!byId || !viewportIds?.length) return global;

  const lastListedId = listedIds?.length ? listedIds[listedIds.length - 1] : undefined;
  const lastChatMessageId = selectChatLastMessageId(global, chatId);
  const isTailKnown = lastListedId !== undefined && lastChatMessageId !== undefined
    && lastListedId >= lastChatMessageId;

  const sortedKnownIds = Object.keys(byId).map(Number).sort((a, b) => a - b);
  const messagesToAdd: Record<number, ApiMessage> = {};
  const listedIdsToAdd: number[] = [];
  const outlyingIdsToAdd: number[] = [];
  const viewportIdsToAdd: number[] = [];

  records.forEach((record) => {
    if (byId[record.id]) return;

    const isInListed = Boolean(listedIds?.length) && isInsideSortedArrayRange(record.id, listedIds);
    const isInOutlying = outlyingLists.some((list) => isInsideSortedArrayRange(record.id, list));
    const isInTail = isTailKnown && record.id > lastListedId;
    if (!isInListed && !isInOutlying && !isInTail) return;

    const neighborDate = findNeighborDate(byId, sortedKnownIds, record.id) ?? record.deletedAt;
    messagesToAdd[record.id] = applyDeletedRecordToMessage(record, neighborDate);

    if (isInListed || isInTail) {
      listedIdsToAdd.push(record.id);
    } else {
      outlyingIdsToAdd.push(record.id);
    }

    const isInViewport = isInsideSortedArrayRange(record.id, viewportIds)
      || (isInTail && viewportIds[viewportIds.length - 1] === lastListedId);
    if (isInViewport) viewportIdsToAdd.push(record.id);
  });

  if (!Object.keys(messagesToAdd).length) return global;

  global = addChatMessagesById(global, chatId, messagesToAdd);
  if (listedIdsToAdd.length) global = updateListedIds(global, chatId, MAIN_THREAD_ID, listedIdsToAdd);
  outlyingIdsToAdd.forEach((id) => {
    global = updateOutlyingLists(global, chatId, MAIN_THREAD_ID, [id]);
  });
  if (viewportIdsToAdd.length) {
    global = safeReplaceViewportIds(global, chatId, MAIN_THREAD_ID, [...viewportIds, ...viewportIdsToAdd], tabId);
  }

  return global;
}

export function removeKeptDeletedMessages<T extends GlobalState>(global: T): T {
  Object.entries(global.messages.byChatId).forEach(([chatId, { byId }]) => {
    const keptIds = Object.values(byId).filter((message) => message.deletedAt).map((message) => message.id);
    if (keptIds.length) {
      global = deleteChatMessages(global, chatId, keptIds, { shouldPreserveMedia: true });
    }
  });

  return global;
}

function findNeighborDate(byId: Record<number, ApiMessage>, sortedIds: number[], id: number) {
  const previousId = sortedIds.findLast((knownId) => knownId < id && !byId[knownId].hasNoDeletedCopy);
  if (previousId !== undefined) return byId[previousId].date;

  const nextId = sortedIds.find((knownId) => knownId > id && !byId[knownId].hasNoDeletedCopy);
  return nextId !== undefined ? byId[nextId].date : undefined;
}
