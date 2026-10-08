/** @jsxImportSource @teact */
import './relay-ui-audit.fixture';
import { useState } from '../src/lib/teact/teact';
import TeactDOM from '../src/lib/teact/teact-dom';
import { getActions, getGlobal, setGlobal } from '../src/global';
import { requestMutation } from '../src/lib/fasterdom/fasterdom';
import { closeDocumentReader, openDocumentReader } from '../src/util/documentReaderState';
import NewContactModal from '../src/components/main/NewContactModal';
import ReportModal from '../src/components/modals/reportModal/ReportModal';
import CountryPickerModal from '../src/components/common/CountryPickerModal';
import PasswordConfirmModal from '../src/components/common/PasswordConfirmModal';
import RemoveFormattingModal from '../src/components/common/RemoveFormattingModal';
import SafeLinkModal from '../src/components/main/SafeLinkModal';
import BrowserCloseConfirmationModal from '../src/components/main/BrowserCloseConfirmationModal';
import MuteChatModal from '../src/components/left/MuteChatModal';
import PinMessageModal from '../src/components/common/PinMessageModal';
import DeleteChatModal from '../src/components/common/DeleteChatModal';
import AttachmentModalItem from '../src/components/middle/composer/AttachmentModalItem';
import Modal from '../src/components/ui/Modal';
import type { ApiAttachment, ApiCountry } from '../src/api/types';

const countries: ApiCountry[] = [
  { iso2: 'RU', defaultName: 'Russia', name: 'Россия' },
  { iso2: 'DE', defaultName: 'Germany', name: 'Deutschland' },
  { iso2: 'JP', defaultName: 'Japan' },
  { iso2: 'ZZ', defaultName: 'Hidden synthetic country', isHidden: true },
];
const events: { name: string; detail?: unknown }[] = [];
type AdditionalAudit = { events: typeof events; open?: (kind: string) => void; close?: NoneToVoidFunction; openDocument?: (extension: string) => void; openChatLanguage?: NoneToVoidFunction; openDeleteMessage?: NoneToVoidFunction };
const audit: AdditionalAudit = (window as any).__relayAdditional = { events };
let closeCurrent: NoneToVoidFunction = () => undefined;
const protectedNames = [
  'updateContact', 'importContact', 'reportMessages', 'reportStory', 'openPreviousReportModal',
  'pinMessage', 'updateChatMutedState', 'updateTopicMutedState', 'deleteHistory', 'deleteSavedHistory',
  'deleteChat', 'deleteChannel', 'deleteChatUser', 'leaveChannel', 'leaveBasicGroup', 'blockUser',
  'deleteMessages', 'deleteScheduledMessages', 'requestMessageTranslation', 'requestChatTranslation',
  'closeBrowserModal', 'showNotification', 'clearTwoFaError', 'downloadMedia',
];
function record(name: string, detail?: unknown) { events.push({ name, detail }); }
function installProtectedActions() {
  const actions = getActions() as any;
  protectedNames.forEach((name) => { actions[name] = (detail: unknown) => record(name, detail); });
  ['closeNewContactDialog', 'closeReportModal', 'closeBrowserCloseConfirmationModal', 'toggleSafeLinkModal'].forEach((name) => {
    actions[name] = () => { record(name); closeCurrent(); };
  });
  actions.checkPassword = (payload: { currentPassword: string; onSuccess: NoneToVoidFunction }) => {
    record('checkPassword', { length: payload.currentPassword.length, preservesFixtureWhitespace: payload.currentPassword === ' a ' });
    payload.onSuccess();
  };
  window.open = () => { record('windowOpen'); return undefined as any; };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => record('clipboard', { length: text.length }), write: async () => record('clipboard') } });
  document.execCommand = (command: string) => { record('clipboardFallback', { command }); return true; };
}
const image = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#486a86"/><text x="60" y="210" font-size="36" fill="white">Synthetic attachment preview</text></svg>'], { type: 'image/svg+xml' });
const imageUrl = URL.createObjectURL(image);
const photo: ApiAttachment = { blobUrl: imageUrl, filename: 'synthetic-photo.png', mimeType: 'image/png', size: image.size, quick: { width: 800, height: 450 } };
const file: ApiAttachment = { blobUrl: imageUrl, filename: 'Synthetic research report — длинное имя.txt', mimeType: 'text/plain', size: 1024 };
const reportBase = { chatId: '101', messageIds: [1], description: '', subject: 'message' as const };

function AdditionalModals() {
  const [kind, setKind] = useState<string>();
  const close = () => { record('close', kind); setKind(undefined); };
  closeCurrent = close;
  audit.open = (next: string) => {
    installProtectedActions();
    const global = getGlobal();
    setGlobal({ ...global, twoFaSettings: { ...global.twoFaSettings, isLoading: next === 'password-loading', hint: 'Synthetic hint' } });
    setKind(next);
  };
  audit.close = () => { closeDocumentReader(); getActions().closeChatLanguageModal(); getActions().closeDeleteMessageModal(); setKind(undefined); };
  audit.openDocument = (extension: string) => {
    installProtectedActions();
    const text = extension === 'md' ? '# Synthetic research\n\nAlpha source and alpha comparison.\n\n**Readable preview**.' : 'Synthetic research\nAlpha source\nAlpha comparison\nEnd of fixture';
    const blob = new Blob([text], { type: 'text/plain' });
    openDocumentReader({ document: { mediaType: 'document', fileName: `synthetic-research.${extension}`, size: blob.size, mimeType: 'text/plain' }, blobUrl: URL.createObjectURL(blob) });
  };
  audit.openChatLanguage = () => {
    installProtectedActions();
    getActions().openChatLanguageModal({ chatId: '101', messageId: Object.values(getGlobal().messages.byChatId['101'].byId)[0].id });
  };
  audit.openDeleteMessage = () => {
    installProtectedActions();
    getActions().openDeleteMessageModal({ chatId: '101', messageIds: [Object.values(getGlobal().messages.byChatId['101'].byId)[0].id] });
  };
  audit.events = events;
  if (!kind) return undefined;
  const submit = (name: string) => () => record(name);
  switch (kind) {
    case 'contact': return <NewContactModal key={kind} isOpen isByPhoneNumber />;
    case 'contact-edit': return <NewContactModal key={kind} isOpen userId="101" />;
    case 'report-options': return <ReportModal key={kind} modal={{ ...reportBase, sections: [{ type: 'options', title: 'Synthetic report options', options: [{ text: 'Synthetic spam', option: 'spam' }, { text: 'Synthetic other', option: 'other' }] }] }} />;
    case 'report-comment': return <ReportModal key={kind} modal={{ ...reportBase, sections: [{ type: 'comment', title: 'Synthetic report comment', option: 'other' }] }} />;
    case 'country': return <CountryPickerModal key={kind} isOpen title="Synthetic country selection" countryList={countries} initialSelectedCountryIds={['RU']} selectionLimit={2} emptySelectionMessage="Synthetic empty selection" onSelectionLimit={(limit) => record('selectionLimit', limit)} onClose={close} onSubmit={(ids) => record('countrySubmit', ids)} />;
    case 'password': case 'password-loading': return <PasswordConfirmModal key={kind} isOpen onClose={close} onSubmit={(password) => record('passwordSubmit', { length: password.length })} />;
    case 'formatting': return <RemoveFormattingModal key={kind} isOpen onClose={close} onCloseAnimationEnd={() => undefined} onRemoveFormatting={submit('removeFormatting')} onSubscribeToPremium={submit('subscribe')} />;
    case 'safe-link': return <SafeLinkModal key={kind} isOpen modal="https://example.test/public/selected-source?fixture=synthetic" />;
    case 'browser-close': return <BrowserCloseConfirmationModal key={kind} modal />;
    case 'mute': return <MuteChatModal key={kind} isOpen chatId="101" onClose={close} />;
    case 'pin': return <PinMessageModal key={kind} isOpen chatId="101" messageId={1} onClose={close} />;
    case 'delete-chat': return <DeleteChatModal key={kind} isOpen chat={getGlobal().chats.byId['101']} onClose={close} />;
    case 'attachment-photo': case 'attachment-file': return <Modal key={kind} isOpen title="Synthetic attachment body" className="audit-additional-attachment" onClose={close} hasCloseButton><AttachmentModalItem attachment={kind === 'attachment-photo' ? photo : file} shouldDisplayCompressed isSingle index={0} onDelete={submit('attachmentDelete')} onEdit={submit('attachmentEdit')} onToggleSpoiler={submit('attachmentSpoiler')} /></Modal>;
    default: return undefined;
  }
}
const additionalRoot = document.createElement('div');
additionalRoot.id = 'relay-ui-additional-modals-root';
document.body.append(additionalRoot);
requestMutation(() => TeactDOM.render(<AdditionalModals />, additionalRoot));


