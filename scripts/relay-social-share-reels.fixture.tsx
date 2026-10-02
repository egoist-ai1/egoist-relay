/** @jsxImportSource @teact */
// Actual App entry. Only synthetic fixture state and local transport callbacks are exposed.
import '../src/index';
import { getGlobal, setGlobal } from '../src/global';
import type { ApiChat, ApiUser } from '../src/api/types';
import { selectTabState } from '../src/global/selectors';
import { ANTIGRAVITY_THEMES, applyAntigravityTheme } from '../src/util/antigravityThemes';
import { getActions } from '../src/global';

(window as any).__reelReceiver = {
  state: () => ({ chatCount: Object.keys(getGlobal().chats?.byId || {}).length, auth: getGlobal().auth?.state,
    currentChatId: getGlobal().byTabId ? selectTabState(getGlobal()).messageLists?.[0]?.chatId : undefined }),
  seed: () => {
    const global = getGlobal();
    const user: ApiUser = { id: '900101', isMin: false, type: 'userTypeRegular', firstName: 'Reel Fixture', lastName: 'Recipient', phoneNumber: '0' };
    const recent: ApiUser = { id: '900102', isMin: false, type: 'userTypeRegular', firstName: 'Quick Contact', phoneNumber: '0' };
    const recentChat: ApiChat = { id: '900102', type: 'chatTypePrivate', title: 'Quick Contact' };
    const chat: ApiChat = { id: '900101', type: 'chatTypePrivate', title: 'Reel Fixture Recipient' };
    setGlobal({ ...global, users: { ...global.users, byId: { ...global.users.byId, [user.id]: user, [recent.id]: recent } },
      chats: { ...global.chats, byId: { ...global.chats.byId, [chat.id]: chat, [recentChat.id]: recentChat },
        listIds: { ...global.chats.listIds, active: [chat.id, recentChat.id, ...(global.chats.listIds.active || []).filter((id) => id !== chat.id)] } },
      topPeerCategories: { ...global.topPeerCategories, correspondents: { peerIds: [user.id, recent.id], ratingsByPeerId: { [user.id]: 2, [recent.id]: 1 } } },
      chatFolders: { ...global.chatFolders, orderedIds: [0, 991], byId: { ...global.chatFolders.byId, 991: {
        id: 991, title: { text: 'Fixture Folder' }, includedChatIds: [recent.id], excludedChatIds: [],
      } } } });
  },
  paid: (enabled: boolean) => {
    const global = getGlobal();
    setGlobal({ ...global, users: { ...global.users,
      byId: { ...global.users.byId, '900101': { ...global.users.byId['900101'], paidMessagesStars: enabled ? 5 : undefined } },
      fullInfoById: { ...global.users.fullInfoById, '900101': { ...global.users.fullInfoById['900101'], paidMessagesStars: enabled ? 5 : undefined } },
    }, stars: { topupOptions: [], history: { all: undefined, inbound: undefined, outbound: undefined }, ...global.stars, balance: { currency: 'XTR', amount: 50, nanos: 0 } },
      settings: { ...global.settings, byKey: { ...global.settings.byKey, shouldPaidMessageAutoApprove: false } } });
  },
  theme: (id: string) => {
    const theme = ANTIGRAVITY_THEMES.find((item) => item.id === id)!;
    getActions().setSharedSettingOption({ theme: theme.base, shouldUseSystemTheme: false }); applyAntigravityTheme(id);
  },
  emit: (request: unknown) => (window as any).__relayNativeMock.emit('multi-social-share', request),
};
