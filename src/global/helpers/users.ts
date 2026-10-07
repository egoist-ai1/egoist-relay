import type { ApiPeer, ApiUser, ApiUserStatus } from '../../api/types';
import type { OldLangFn } from '../../hooks/useOldLang';
import { MAIN_THREAD_ID } from '../../api/types';

import { ANONYMOUS_USER_ID, SERVICE_NOTIFICATIONS_USER_ID } from '../../config';
import { formatFullDate, formatTime } from '../../util/dates/oldDateFormat';
import { DAY } from '../../util/dates/units';
import { orderBy } from '../../util/iteratees';
import { formatPhoneNumber } from '../../util/phoneNumber';
import { getIsUserRecentlyActive, getRealUserActivity, recordUserActivity } from '../../util/realUserActivity';
import { getServerTime, getServerTimeOffset } from '../../util/serverTime';
import { getGlobal } from '../index';
import { selectChatLastMessage } from '../selectors';
import { selectThreadReadState } from '../selectors/threads';

export function getUserFirstOrLastName(user?: ApiUser) {
  if (!user) {
    return undefined;
  }

  switch (user.type) {
    case 'userTypeBot':
      return user.firstName;
    case 'userTypeRegular': {
      return user.firstName || user.lastName;
    }

    case 'userTypeDeleted':
    case 'userTypeUnknown': {
      return 'Deleted';
    }

    default:
      return undefined;
  }
}

export function getUserFullName(user?: ApiUser) {
  if (!user) {
    return undefined;
  }

  if (isDeletedUser(user)) {
    return 'Deleted Account';
  }

  switch (user.type) {
    case 'userTypeBot':
    case 'userTypeRegular': {
      if (user.firstName && user.lastName) {
        return `${user.firstName} ${user.lastName}`;
      }

      if (user.firstName) {
        return user.firstName;
      }

      if (user.lastName) {
        return user.lastName;
      }

      if (user.phoneNumber) {
        return `+${formatPhoneNumber(user.phoneNumber)}`;
      }

      break;
    }
  }

  return undefined;
}

function formatTimestampStatus(lang: OldLangFn, timestamp: number): string {
  const serverTimeOffset = getServerTimeOffset();
  const now = new Date(Date.now() + serverTimeOffset * 1000);
  const wasOnlineDate = new Date(timestamp * 1000);

  if (wasOnlineDate >= now) {
    return lang('LastSeen.JustNow');
  }

  const diffMs = now.getTime() - wasOnlineDate.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) {
    return lang('LastSeen.JustNow');
  }

  if (diffSec < 3600) {
    const minutes = Math.floor(diffSec / 60);
    return lang('LastSeen.MinutesAgo', minutes);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const serverToday = new Date(today.getTime() + serverTimeOffset * 1000);
  if (wasOnlineDate > serverToday) {
    if (diffSec < 6 * 3600) {
      const hours = Math.floor(diffSec / 3600);
      return lang('LastSeen.HoursAgo', hours);
    }
    return lang('LastSeen.TodayAt', formatTime(lang, wasOnlineDate));
  }

  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const serverYesterday = new Date(yesterday.getTime() + serverTimeOffset * 1000);
  if (wasOnlineDate > serverYesterday) {
    return lang('LastSeen.YesterdayAt', formatTime(lang, wasOnlineDate));
  }

  return lang('LastSeen.AtDate', formatFullDate(lang, wasOnlineDate));
}

function getLatestUserActivity(userId: string): number | undefined {
  let latest = getRealUserActivity(userId) || 0;
  try {
    const global = getGlobal();
    // 1. Check messages in 1-on-1 chat
    const chatMessages = global.messages?.byChatId?.[userId];
    if (chatMessages?.byId) {
      for (const id in chatMessages.byId) {
        const msg = chatMessages.byId[id];
        if (msg && msg.senderId === userId && msg.date) {
          if (msg.date > latest) {
            latest = msg.date;
          }
        }
      }
    }
    // 2. Check chat lastMessage via selector
    const lastMsg = selectChatLastMessage(global, userId);
    if (lastMsg && lastMsg.senderId === userId && lastMsg.date) {
      if (lastMsg.date > latest) {
        latest = lastMsg.date;
      }
    }
    // 3. If outbox message was read by the user, user was on Telegram at or after that date
    const threadReadState = selectThreadReadState(global, userId, MAIN_THREAD_ID);
    if (threadReadState?.lastReadOutboxMessageId && chatMessages?.byId) {
      const readMsg = chatMessages.byId[threadReadState.lastReadOutboxMessageId];
      if (readMsg?.date && readMsg.date > latest) {
        latest = readMsg.date;
      }
    }
    // 4. Check other chats / groups where user may have participated
    if (global.messages?.byChatId) {
      for (const cId in global.messages.byChatId) {
        if (cId === userId) continue;
        const otherChat = global.messages.byChatId[cId];
        if (otherChat?.byId) {
          for (const msgId in otherChat.byId) {
            const m = otherChat.byId[msgId];
            if (m && m.senderId === userId && m.date && m.date > latest) {
              latest = m.date;
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  if (latest > 0) {
    recordUserActivity(userId, latest);
    return latest;
  }
  return undefined;
}

export function getUserStatus(
  lang: OldLangFn, user: ApiUser, userStatus: ApiUserStatus | undefined,
) {
  if (user.id === SERVICE_NOTIFICATIONS_USER_ID) {
    return lang('ServiceNotifications');
  }

  if (user.isSupport) {
    return lang('SupportStatus');
  }

  if (user.type && user.type === 'userTypeBot') {
    if (user.botActiveUsers) {
      return lang('BotUsers', user.botActiveUsers, 'i');
    }
    return lang('Bot');
  }

  if (userStatus?.type === 'userStatusOnline') {
    recordUserActivity(user.id);
    return lang('Online');
  }

  // Check real message/session activity from the user
  const latestActivity = Math.max(getLatestUserActivity(user.id) || 0, getRealUserActivity(user.id) || 0);
  const wasOnline = userStatus?.type === 'userStatusOffline' ? userStatus.wasOnline : undefined;
  const now = Math.floor(Date.now() / 1000);

  // If user hides their last seen (userStatusRecently, userStatusLastWeek, userStatusLastMonth, userStatusEmpty)
  // or Telegram returns a stale/frozen wasOnline (e.g. from months ago) while we have real recorded activity:
  // always prioritize real activity!
  const isWasOnlineStale = wasOnline && (now - wasOnline > 7 * 86400); // older than 7 days

  let effectiveTimestamp: number | undefined;
  if (latestActivity > 0 && (!wasOnline || latestActivity >= wasOnline || isWasOnlineStale)) {
    effectiveTimestamp = latestActivity;
  } else if (wasOnline && !isWasOnlineStale) {
    effectiveTimestamp = wasOnline;
  } else if (latestActivity > 0) {
    effectiveTimestamp = latestActivity;
  }

  if (effectiveTimestamp && effectiveTimestamp > 0) {
    const diffSec = now - effectiveTimestamp;
    if (diffSec < 180) {
      return lang('Online');
    }
    return formatTimestampStatus(lang, effectiveTimestamp);
  }

  if (!userStatus) {
    return '';
  }

  switch (userStatus.type) {
    case 'userStatusEmpty':
      return lang('ALongTimeAgo');
    case 'userStatusLastMonth':
      return lang('WithinAMonth');
    case 'userStatusLastWeek':
      return lang('WithinAWeek');
    case 'userStatusRecently':
      return lang('Lately');
    case 'userStatusOffline':
      return lang('LastSeen.Offline');
    default:
      return undefined;
  }
}

export function isUserOnline(user: ApiUser, userStatus?: ApiUserStatus, withSelfOnline = false) {
  const { id, type } = user;

  if (id === SERVICE_NOTIFICATIONS_USER_ID) {
    return false;
  }

  if (user.isSelf && !withSelfOnline) {
    return false;
  }

  if (getIsUserRecentlyActive(id, 180)) {
    return true;
  }

  if (!userStatus) {
    return false;
  }

  return userStatus.type === 'userStatusOnline' && type !== 'userTypeBot';
}

export function isDeletedUser(user: ApiUser) {
  return (user.type === 'userTypeDeleted' || user.type === 'userTypeUnknown')
    && user.id !== SERVICE_NOTIFICATIONS_USER_ID;
}

export function isUserBot(user: ApiUser) {
  return user.type === 'userTypeBot';
}

export function getCanAddContact(user: ApiUser) {
  return !user.isSelf && !user.isContact && !isUserBot(user) && user.id !== ANONYMOUS_USER_ID;
}

export function sortUserIds(
  userIds: string[],
  usersById: Record<string, ApiUser>,
  userStatusesById: Record<string, ApiUserStatus>,
  priorityIds?: string[],
) {
  return orderBy(userIds, (id) => {
    const now = getServerTime();

    if (priorityIds && priorityIds.includes(id)) {
      // Assuming that online status expiration date can't be as far as two days from now,
      // this should place prioritized on top of the list.
      // Then we subtract index of `id` in `priorityIds` to preserve selected order
      return now + (48 * 60 * 60) - (priorityIds.length - priorityIds.indexOf(id));
    }

    const user = usersById[id];
    const userStatus = userStatusesById[id];
    if (!user || !userStatus) {
      return 0;
    }

    if (userStatus.type === 'userStatusOnline') {
      return userStatus.expires;
    } else if (userStatus.type === 'userStatusOffline' && userStatus.wasOnline) {
      return userStatus.wasOnline;
    }

    switch (userStatus.type) {
      case 'userStatusRecently':
        return now - DAY;
      case 'userStatusLastWeek':
        return now - DAY * 7;
      case 'userStatusLastMonth':
        return now - DAY * 7 * 30;
      default:
        return 0;
    }
  }, 'desc');
}

export function getMainUsername(userOrChat: ApiPeer) {
  return userOrChat.usernames?.find((u) => u.isActive)?.username;
}

export function getPeerStoryHtmlId(userId: string) {
  return `peer-story${userId}`;
}
