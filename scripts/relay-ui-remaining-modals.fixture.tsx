/** @jsxImportSource @teact */
import './relay-ui-audit.fixture';
import { useState } from '../src/lib/teact/teact';
import TeactDOM from '../src/lib/teact/teact-dom';
import { getActions, getGlobal, setGlobal } from '../src/global';
import { selectTabState } from '../src/global/selectors';
import { selectSharedSettings } from '../src/global/selectors/sharedState';
import { requestMutation } from '../src/lib/fasterdom/fasterdom';
import type { ApiChat, ApiChatFolder, ApiPhoto, ApiUser } from '../src/api/types';
import BlockUserModal from '../src/components/left/settings/BlockUserModal';
import SensitiveContentConfirmModal from '../src/components/common/SensitiveContentConfirmModal';
import ReportAvatarModal from '../src/components/common/ReportAvatarModal';
import UnpinAllMessagesModal from '../src/components/common/UnpinAllMessagesModal';
import DeleteFolderDialog from '../src/components/main/DeleteFolderDialog';
import BotTrustModal from '../src/components/main/BotTrustModal';
import RemoveGroupUserModal from '../src/components/right/management/RemoveGroupUserModal';
import PromptDialog from '../src/components/modals/prompt/PromptDialog';

const events: { name: string; detail?: unknown }[] = [];
const group: ApiChat = { id: '-900001', type: 'chatTypeBasicGroup', title: 'Synthetic research group', isOwner: true, membersCount: 4 };
const member: ApiUser = { id: '900002', isMin: false, type: 'userTypeRegular', firstName: 'Synthetic', lastName: 'Member', phoneNumber: '0' };
const admin: ApiUser = { id: '900003', isMin: false, type: 'userTypeRegular', firstName: 'Synthetic', lastName: 'Admin', phoneNumber: '0' };
const bot: ApiUser = { id: '900004', isMin: false, type: 'userTypeBot', firstName: 'Synthetic permission bot', phoneNumber: '0' };
const photo: ApiPhoto = { mediaType: 'photo', id: '900005', date: 0, sizes: [] };
const folder: ApiChatFolder = { id: 900006, title: { text: 'Synthetic research folder' }, includedChatIds: ['101'], excludedChatIds: [] };
const sharedFolder: ApiChatFolder = { ...folder, hasMyInvites: true };
let closeCurrent: NoneToVoidFunction = () => undefined;
let isInstalled = false;
const originalClosers: Record<string, (...args: any[]) => unknown> = {};
const protectedNames = ['blockUser', 'deleteChatMember', 'loadMoreMembers', 'reportProfilePhoto', 'deleteChatFolder', 'openDeleteChatFolderModal', 'markBotTrusted', 'updateGlobalPrivacySettings', 'setPrivacyVisibility', 'showNotification', 'openPremiumModal', 'setChatHistoryTtl', 'updateBirthday', 'suggestBirthday', 'editChatParticipantRank', 'openSettingsScreen'];
const globalCloserNames = ['closePrivacySettingsNoticeModal', 'closeAutoDeleteTimerModal', 'closeBirthdaySetupModal', 'closeEditRankModal'];
function record(name: string, detail?: unknown) { events.push({ name, detail }); }
function installLocalBoundary() {
  if (isInstalled) return;
  isInstalled = true;
  const actions = getActions() as any;
  protectedNames.forEach((name) => { actions[name] = (payload: any) => record(name, payload ? { userId: payload.userId, chatId: payload.chatId, peerId: payload.peerId, reason: payload.reason, descriptionLength: payload.description?.length, period: payload.period, birthday: payload.birthday, rank: payload.rank, isWriteAllowed: payload.isWriteAllowed, folderId: payload.folderId, isConfirmedForChatlist: payload.isConfirmedForChatlist, visibility: payload.visibility, shouldHideReadMarks: payload.shouldHideReadMarks } : undefined); });
  ['closeDeleteChatFolderModal', 'cancelBotTrustRequest'].forEach((name) => { actions[name] = () => { record(name); closeCurrent(); }; });
  globalCloserNames.forEach((name) => {
    originalClosers[name] = actions[name];
    actions[name] = (...args: any[]) => { record(name); return originalClosers[name](...args); };
  });
}
function seedData(kind: string) {
  const global = getGlobal();
  const userId = global.currentUserId!;
  setGlobal({ ...global,
    users: { ...global.users, byId: { ...global.users.byId, [member.id]: member, [admin.id]: admin, [bot.id]: bot } },
    chats: { ...global.chats, byId: { ...global.chats.byId, [group.id]: kind === 'rank-disabled' ? { ...group, isOwner: false, isNotJoined: true } : group }, fullInfoById: { ...global.chats.fullInfoById, [group.id]: { members: [{ userId }, { userId: member.id }, { userId: admin.id, isAdmin: true }], ttlPeriod: 0 } } },
    contactList: { ...global.contactList, userIds: kind === 'block-empty' ? [] : [member.id, admin.id, userId] },
    blocked: { ...global.blocked, ids: [admin.id] },
  });
}
type RemainingAudit = { events: typeof events; open?: (kind: string) => void; close?: NoneToVoidFunction; state?: () => unknown };
const audit: RemainingAudit = (window as any).__relayRemaining = { events };
function RemainingModals() {
  const [kind, setKind] = useState<string>();
  const [shouldAlwaysShow, setShouldAlwaysShow] = useState(false);
  const close = () => { record('close', kind); setKind(undefined); };
  closeCurrent = close;
  audit.close = () => { globalCloserNames.forEach((name) => originalClosers[name]?.()); setKind(undefined); };
  audit.state = () => ({ themeBase: selectSharedSettings(getGlobal()).theme, tab: { birthday: Boolean(selectTabState(getGlobal()).birthdaySetupModal), autoDelete: Boolean(selectTabState(getGlobal()).autoDeleteTimerModal), rank: Boolean(selectTabState(getGlobal()).editRankModal), privacy: Boolean(selectTabState(getGlobal()).privacySettingsNoticeModal) } });
  audit.open = (next: string) => {
    installLocalBoundary(); seedData(next); setShouldAlwaysShow(false);
    const actions = getActions();
    if (next === 'privacy-read' || next === 'privacy-last') { actions.openPrivacySettingsNoticeModal({ chatId: '101', isReadDate: next === 'privacy-read' }); setKind(undefined); return; }
    if (next === 'auto-delete') { actions.openAutoDeleteTimerModal({ chatId: group.id }); setKind(undefined); return; }
    if (next === 'birthday' || next === 'birthday-empty') { actions.openBirthdaySetupModal({ currentBirthday: next === 'birthday' ? { day: 31, month: 1, year: 2000 } : undefined }); setKind(undefined); return; }
    if (next === 'rank' || next === 'rank-disabled') { actions.openEditRankModal({ chatId: group.id, userId: getGlobal().currentUserId!, rank: 'Research' }); setKind(undefined); return; }
    setKind(next);
  };
  if (!kind) return undefined;
  switch (kind) {
    case 'block': case 'block-empty': return <BlockUserModal key={kind} isOpen onClose={close} />;
    case 'sensitive': return <SensitiveContentConfirmModal key={kind} isOpen shouldAlwaysShow={shouldAlwaysShow} onAlwaysShowChanged={(value) => { record('alwaysShow', value); setShouldAlwaysShow(value); }} confirmHandler={() => record('sensitiveConfirm')} onClose={close} />;
    case 'report-avatar': return <ReportAvatarModal key={kind} isOpen peerId={member.id} photo={photo} onClose={close} />;
    case 'unpin': return <UnpinAllMessagesModal key={kind} isOpen chatId={group.id} pinnedMessagesCount={12} onClose={close} onUnpin={() => record('unpin')} />;
    case 'folder': case 'folder-shared': return <DeleteFolderDialog key={kind} folder={kind === 'folder' ? folder : sharedFolder} />;
    case 'bot-trust': return <BotTrustModal key={kind} bot={bot} type="webApp" shouldRequestWriteAccess />;
    case 'remove-user': return <RemoveGroupUserModal key={kind} chat={group} isOpen onClose={close} />;
    case 'prompt': return <PromptDialog key={kind} isOpen title="Synthetic editable prompt" subtitle="Local body fixture with length constraint" placeholder="Synthetic value" maxLength={16} initialValue="Initial" onClose={close} onSubmit={(text) => record('promptSubmit', { text })} />;
    default: return undefined;
  }
}
const root = document.createElement('div'); root.id = 'relay-ui-remaining-modals-root'; document.body.append(root);
requestMutation(() => TeactDOM.render(<RemainingModals />, root));
