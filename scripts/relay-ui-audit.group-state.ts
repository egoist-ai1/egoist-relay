import type { ApiChatFolder, ApiChatFullInfo, ApiExportedInvite, ApiPrivacyKey, ApiPrivacySettings } from '../src/api/types';
import { MAIN_THREAD_ID } from '../src/api/types';
import { getActions, getGlobal, setGlobal } from '../src/global';
import { selectRightColumnContentKey, selectTabState } from '../src/global/selectors';
import { getCurrentTabId } from '../src/util/establishMultitabRole';
import { LeftColumnContent, ManagementScreens, NewChatMembersProgress, RightColumnContent, SettingsScreens } from '../src/types';

const topicIcons = { id: '900000001', accessHash: '0', title: 'Synthetic topic icons', count: 0, shortName: 'fixture_topic_icons', isEmoji: true as const, stickers: [] };
const CHAT_ID = '-1000000000201';
const folder: ApiChatFolder = { id: 2, title: { text: 'Research sources' }, includedChatIds: ['101', CHAT_ID], excludedChatIds: [], groups: true };
const invite: ApiExportedInvite = { link: 'https://t.me/+relay-synthetic-fixture', date: 1790888400, adminId: '1', title: 'Synthetic research room', usage: 2 };
const fullInfo: ApiChatFullInfo = { about: 'Synthetic group for isolated route fixtures. No live account changes.', canViewMembers: true,
  members: [{ userId: '1', isOwner: true }, { userId: '101', isAdmin: true }], kickedMembers: [],
  adminMembersById: { '101': { userId: '101', isAdmin: true, promotedByUserId: '1', adminRights: { changeInfo: true } } },
  inviteLink: invite.link, enabledReactions: { type: 'all' }, reactionsLimit: 3, requestsPending: 0, canViewStatistics: true };

function seedSettings() {
  const global = getGlobal();
  const privacy = { ...global.settings.privacy };
  const keys: ApiPrivacyKey[] = ['phoneNumber', 'addByPhone', 'lastSeen', 'profilePhoto', 'voiceMessages', 'forwards', 'chatInvite', 'phoneCall', 'phoneP2P', 'bio', 'birthday', 'gifts', 'noPaidMessages'];
  keys.forEach((key) => { privacy[key] = { visibility: 'contacts', allowUserIds: ['101'], allowChatIds: [CHAT_ID], blockUserIds: [], blockChatIds: [], botsPrivacy: 'none' } satisfies ApiPrivacySettings; });
  setGlobal({ ...global, chatFolders: { ...global.chatFolders, byId: { ...global.chatFolders.byId, 2: folder }, orderedIds: [...new Set([...(global.chatFolders.orderedIds || []), 2])], invites: { ...global.chatFolders.invites, 2: [] } }, settings: { ...global.settings, privacy }, activeWebSessions: {
    byHash: { synthetic: { hash: 'synthetic', botId: '1', domain: 'fixture.example.test', browser: 'Chromium isolated profile', platform: 'Windows', dateCreated: 1790888400, dateActive: 1790888400, ip: '192.0.2.1', region: 'Synthetic' } }, orderedHashes: ['synthetic'],
  } });
}

function seedManagement() {
  const global = getGlobal(); const tab = selectTabState(global); const tabId = getCurrentTabId();
  const chat = { ...global.chats.byId[CHAT_ID], id: CHAT_ID, type: 'chatTypeSuperGroup' as const, accessHash: '0', isOwner: true, isForum: true, title: 'Relay — Synthetic research group', membersCount: 2, defaultBannedRights: {} };
  const chatManagement = { isActive: true, invites: [invite], revokedInvites: [], editingInvite: invite, inviteInfo: { invite, importers: [], requesters: [] } };
  setGlobal({ ...global, defaultTopicIconsId: topicIcons.id, stickers: { ...global.stickers, setsById: { ...global.stickers.setsById, [topicIcons.id]: topicIcons } }, chats: { ...global.chats, byId: { ...global.chats.byId, [CHAT_ID]: chat }, fullInfoById: { ...global.chats.fullInfoById, [CHAT_ID]: fullInfo } },
    byTabId: { ...global.byTabId, [tabId]: { ...tab, messageLists: [{ chatId: CHAT_ID, threadId: MAIN_THREAD_ID, type: 'thread' }],
      management: { ...tab.management, byChatId: { ...tab.management.byChatId, [CHAT_ID]: chatManagement } },
    } },
  });
}

function openSettings(name: keyof typeof SettingsScreens) {
  if (name === 'FoldersCreateFolder') getActions().requestNextFoldersAction({ foldersAction: { type: 'reset' } });
  else if (name.startsWith('Folders')) getActions().requestNextFoldersAction({ foldersAction: { type: 'editFolder', payload: folder } });
  getActions().openSettingsScreen({ screen: SettingsScreens[name] });
}

function openRight(name: keyof typeof RightColumnContent) {
  seedManagement(); const global = getGlobal(); const tabId = getCurrentTabId(); const tab = selectTabState(global);
  const next = { ...tab, management: { ...tab.management, byChatId: { ...tab.management.byChatId, [CHAT_ID]: { ...tab.management.byChatId[CHAT_ID], isActive: name === 'Management' } } },
    chatInfo: { ...tab.chatInfo, isOpen: name === 'ChatInfo' }, isStatisticsShown: ['Statistics', 'MessageStatistics', 'StoryStatistics'].includes(name),
    statistics: { ...tab.statistics, currentMessageId: name === 'MessageStatistics' ? 1 : undefined, currentStoryId: name === 'StoryStatistics' ? 1 : undefined },
    pollResults: { chatId: name === 'PollResults' ? CHAT_ID : undefined, messageId: name === 'PollResults' ? 1 : undefined },
    newChatMembersProgress: name === 'AddingMembers' ? NewChatMembersProgress.InProgress : NewChatMembersProgress.Closed,
    createTopicPanel: name === 'CreateTopic' ? { chatId: CHAT_ID } : undefined,
    editTopicPanel: name === 'EditTopic' ? { chatId: CHAT_ID, topicId: 1 } : undefined,
    boostStatistics: name === 'BoostStatistics' ? { chatId: CHAT_ID } : undefined,
    monetizationStatistics: name === 'MonetizationStatistics' ? { chatId: CHAT_ID } : undefined,
    leftColumn: { ...tab.leftColumn, contentKey: LeftColumnContent.ChatList },
  };
  setGlobal({ ...global, byTabId: { ...global.byTabId, [tabId]: next } });
}

export function registerGroups() {
(window as any).__relayAudit.groups = {
  seedSettings, seedManagement, openSettings, openRight,
  seedReply: () => {
    const global = getGlobal(); const messages = global.messages.byChatId['101'];
    const values = Object.values(messages.byId); const incoming = values.find(item => !item.isOutgoing)!;
    const outgoing = values.find(item => item.isOutgoing)!;
    setGlobal({ ...global, messages: { ...global.messages, byChatId: { ...global.messages.byChatId,
      '101': { ...messages, byId: { ...messages.byId, [outgoing.id]: { ...outgoing, replyInfo: { type: 'message', replyToMsgId: incoming.id } } } },
    } } });
  },
  settings: Object.keys(SettingsScreens).filter((key) => !/^\d+$/.test(key)),
  management: Object.keys(ManagementScreens).filter((key) => !/^\d+$/.test(key)),
  right: Object.keys(RightColumnContent).filter((key) => !/^\d+$/.test(key)),
  openManagement: (name: keyof typeof ManagementScreens) => { seedManagement(); getActions().requestNextManagementScreen({ screen: ManagementScreens[name] }); },
  state: () => { const global = getGlobal(); const tab = selectTabState(global); return { settings: SettingsScreens[tab.leftColumn.settingsScreen!], right: RightColumnContent[selectRightColumnContentKey(global)!], chatId: tab.messageLists.at(-1)?.chatId, nextManagement: tab.management.byChatId[CHAT_ID]?.nextScreen }; },
};


}
