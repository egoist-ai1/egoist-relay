import type { ActionReturnType } from '../../types';

import { deletedMessagesStorage, getDeletedMessagesLimits } from '../../../util/deletedMessages';
import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { getServerTime } from '../../../util/serverTime';
import { addActionHandler, getGlobal, setGlobal } from '../../index';
import { removeKeptDeletedMessages, restoreDeletedMessages } from '../../reducers/deletedMessages';
import { updateSharedSettings } from '../../reducers/settings';
import { selectSharedSettings } from '../../selectors/sharedState';

addActionHandler('restoreDeletedMessages', async (global, actions, payload): Promise<void> => {
  const { chatId, tabId = getCurrentTabId() } = payload;
  const settings = selectSharedSettings(global);
  if (!settings.shouldKeepDeletedMessages || !global.currentUserId) return;

  const records = await deletedMessagesStorage.loadChat(
    global.currentUserId, chatId, getDeletedMessagesLimits(settings), getServerTime(),
  );
  if (!records.length) return;

  global = getGlobal();
  if (!selectSharedSettings(global).shouldKeepDeletedMessages) return;

  global = restoreDeletedMessages(global, chatId, records, tabId);
  setGlobal(global);
});

addActionHandler('setShouldKeepDeletedMessages', (global, actions, payload): ActionReturnType => {
  global = updateSharedSettings(global, { shouldKeepDeletedMessages: payload.value });

  return payload.value ? global : removeKeptDeletedMessages(global);
});

addActionHandler('clearDeletedMessages', async (): Promise<void> => {
  await deletedMessagesStorage.clear();

  let global = getGlobal();
  global = removeKeptDeletedMessages(global);
  setGlobal(global);
});
