/** @jsxImportSource @teact */
// This entry renders the real App through its original boot path and existing MockClient.
// The runner replaces only native transport; no replica of product JSX is rendered here.
import '../src/index';
import { getActions, getGlobal, setGlobal } from '../src/global';
import { SettingsScreens } from '../src/types';
import { selectTabState } from '../src/global/selectors';
import { ANTIGRAVITY_THEMES, applyAntigravityTheme } from '../src/util/antigravityThemes';

(window as any).__relayAudit = {
  settings: Object.keys(SettingsScreens).filter((key) => !/^\d+$/.test(key)),
  themes: ANTIGRAVITY_THEMES.map(({ id, name, base }) => ({ id, name, base })),
  loadChats: () => getActions().sync(),
  simulateConnected: () => getActions().apiUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateReady' }),
  openSettings: (name: string) => getActions().openSettingsScreen({ screen: (SettingsScreens as any)[name] }),
  openChat: (chatId: string) => getActions().openChat({ id: chatId }),
  closeChat: () => getActions().openChat({ id: undefined }),
  applyTheme: (id: string) => {
    const theme = ANTIGRAVITY_THEMES.find((item) => item.id === id)!;
    getActions().setSharedSettingOption({ theme: theme.base, shouldUseSystemTheme: false });
    applyAntigravityTheme(id);
  },
  setAuthState: (state?: string) => { const global = getGlobal(); setGlobal({ ...global, auth: { ...global.auth, state: state as any,
    phoneNumber: '+79990000000', hint: 'Подсказка пароля', qrCode: { token: 'qa-token', expires: Date.now() / 1000 + 600 } as any } }); },
  notify: (message: string) => getActions().showNotification({ message }),
  setMessageSize: (size: number) => getActions().setSharedSettingOption({ messageTextSize: size }),
  state: () => {
    const global = getGlobal();
    const tab = global.byTabId ? selectTabState(global) : undefined;
    return { auth: global.auth?.state, currentUserId: global.currentUserId, connection: global.connectionState,
      chatCount: Object.keys(global.chats?.byId || {}).length, chatIds: Object.keys(global.chats?.byId || {}), settingsScreen: tab?.leftColumn.settingsScreen,
      leftContent: tab?.leftColumn.contentKey, isSynced: global.isSynced, isSyncing: global.isSyncing,
      currentChatId: tab?.messageLists?.[0]?.chatId };
  },
};



import { useState } from '../src/lib/teact/teact';
import TeactDOM from '../src/lib/teact/teact-dom';
import { requestMutation } from '../src/lib/fasterdom/fasterdom';
import Modal from '../src/components/ui/Modal';
import MessageMeta from '../src/components/middle/message/MessageMeta';
import MenuItem from '../src/components/ui/MenuItem';
import ConfirmDialog from '../src/components/ui/ConfirmDialog';
import RangeSlider from '../src/components/ui/RangeSlider';
import InputText from '../src/components/ui/InputText';
import TextArea from '../src/components/ui/TextArea';
import Checkbox from '../src/components/ui/Checkbox';
import Button from '../src/components/ui/Button';
import FormattedDateModal from '../src/components/middle/composer/FormattedDateModal';
import DeleteProfilePhotoModal from '../src/components/common/DeleteProfilePhotoModal';
import GuardReplaceBotModal from '../src/components/right/management/GuardReplaceBotModal';
import CalendarModal from '../src/components/common/CalendarModal';
import AiTextTranslateEditor from '../src/components/middle/composer/AiMessageEditorModal/AiTextTranslateEditor';
import SocialShareModal from '../src/components/multi/SocialShareModal';

type OverlayKind = 'controls' | 'confirm' | 'date' | 'boundaries' | 'confirm-disabled' | 'confirm-only' | 'nested' | 'media' | 'menu-div' | 'menu-native' | 'delete-photo' | 'guard-bot' | 'calendar-repeat' | 'button-baseline' | 'ai-portal-div' | 'ai-portal-native' | 'ai-portal-two' | 'ai-external' | 'confirm-standard' | 'enter-delegation' | 'delete-messages' | undefined;
const overlayEvents: unknown[] = [];
const AuditOverlays = () => {
  const [kind, setKind] = useState<OverlayKind>();
  const [name, setName] = useState('Egoist Cinema — проверка интерфейса');
  const [bio, setBio] = useState('Исследования, видео и чаты. Длинный текст без обрезки и наложений.');
  const [checked, setChecked] = useState(false);
  const [slider, setSlider] = useState(50);
  const [isNestedOpen, setIsNestedOpen] = useState(false);
  const [isSecondAiOpen, setIsSecondAiOpen] = useState(false);
  const [shareRequest, setShareRequest] = useState<any>();
  (window as any).__relayAudit.openShare = (request: unknown) => {
    const global = getGlobal();
    const folders = [{ id: 2, title: { text: 'Личные' }, includedChatIds: ['101'], excludedChatIds: [], contacts: true },
      { id: 3, title: { text: 'Телеграм' }, includedChatIds: ['101'], excludedChatIds: [], groups: true }];
    setGlobal({ ...global, chatFolders: { ...global.chatFolders,
      byId: { ...global.chatFolders.byId, 2: folders[0], 3: folders[1] },
      orderedIds: [...new Set([...(global.chatFolders.orderedIds || []), 2, 3])] } });
    setShareRequest(request);
  };
  (window as any).__relayAudit.openOverlay = (nextKind?: OverlayKind) => { setShareRequest(undefined); setKind(nextKind); };
  (window as any).__relayAudit.overlayEvents = overlayEvents;
  (window as any).__relayAudit.openDeleteFixture = () => {
    const messages = Object.values(getGlobal().messages.byChatId['101'].byId);
    getActions().openDeleteMessageModal({ chatId: '101', messageIds: [messages[0].id] });
  };
  (window as any).__relayAudit.openCritical = (nextKind: OverlayKind) => {
    const actions = getActions();
    actions.deleteProfilePhoto = () => overlayEvents.push({ protectedDeletePhoto: true });
    actions.deleteChatPhoto = () => overlayEvents.push({ protectedDeleteChatPhoto: true });
    actions.deleteMessages = () => overlayEvents.push({ protectedDeleteMessages: true });
    actions.setAiMessageEditorTranslateOptions = (payload) => overlayEvents.push({ protectedAiOption: payload });
    actions.composeWithAiMessageEditor = (payload) => overlayEvents.push({ protectedAiCompose: payload });
    const global = getGlobal(); const userId = global.currentUserId!;
    setGlobal({ ...global, users: { ...global.users, byId: { ...global.users.byId, [userId]: { ...global.users.byId[userId], isPremium: true } } } });
    setIsSecondAiOpen(nextKind === 'ai-portal-two');
    setKind(nextKind);
  };
  const close = () => { overlayEvents.push({ close: kind }); setKind(undefined); setIsNestedOpen(false); };
  return <>
    {shareRequest && <SocialShareModal request={shareRequest} canSend onClose={async () => setShareRequest(undefined)} />}
    <Modal title="Проверка настоящих контролов Relay" isOpen={kind === 'controls'} onClose={close} isSlim hasCloseButton>
      <InputText id="audit-name" value={name} label="Имя профиля" onChange={(event) => setName(event.target.value)} />
      <TextArea id="audit-bio" value={bio} label="Описание" onChange={(event) => setBio(event.target.value)} />
      <Checkbox id="audit-checkbox" label="Плавная анимация интерфейса" checked={checked} onCheck={setChecked} />
      <RangeSlider className="audit-slider" label="Масштаб текста" min={0} max={100} step={2} value={slider}
        onChange={(value) => { setSlider(value); overlayEvents.push({ slider: value }); }} />
      <RangeSlider className="audit-slider-disabled" label="Недоступная настройка" disabled value={50}
        onChange={(value) => overlayEvents.push({ disabledSlider: value })} />
      <RangeSlider className="audit-slider-readonly" label="Настройка только для чтения" readOnly value={50}
        onChange={(value) => overlayEvents.push({ readOnlySlider: value })} />
      <div className="dialog-buttons mt-2"><Button onClick={close}>Готово</Button></div>
    </Modal>
    <Modal title="Range boundary geometry" isOpen={kind === 'boundaries'} onClose={close} isSlim>
      {[
        { id: 'offset', min: 20, max: 40, value: 30 },
        { id: 'below', min: 0, max: 100, value: -20 },
        { id: 'above', min: 0, max: 100, value: 120 },
        { id: 'zero-span', min: 20, max: 20, value: 20 },
        { id: 'empty-options', options: [], value: 0 },
        { id: 'single-option', options: ['Only option'], value: 0 },
      ].map(({ id, ...props }) => <div data-case={id} className="audit-slider-boundary">
        <RangeSlider {...props} label={id} onChange={() => undefined} />
      </div>)}
    </Modal>
    <ConfirmDialog isOpen={kind === 'confirm' || kind === 'confirm-disabled' || kind === 'confirm-only' || kind === 'confirm-standard'} title="Удаление тестового объекта"
      text="Подтверждение в изолированном fixture. Длинная строка проверяет перенос текста и расположение кнопок."
      confirmLabel="Удалить тестовый объект" confirmIsDestructive={kind !== 'confirm-disabled' && kind !== 'confirm-standard'}
      isConfirmDisabled={kind === 'confirm-disabled'} isOnlyConfirm={kind === 'confirm-only'}
      confirmHandler={() => { overlayEvents.push({ confirmed: true }); close(); }} onClose={close} />
    <Modal className="audit-nested-modal" title="Nested focus fixture" isOpen={kind === 'nested'} onClose={close} isSlim hasCloseButton>
      <InputText id="audit-nested-input" value="Parent input" label="Parent" />
      <InputText id="audit-nested-disabled" value="Disabled input" label="Disabled" disabled />
      <div hidden><button type="button" id="audit-nested-hidden">Hidden</button></div>
      <Button id="audit-nested-trigger" onClick={() => setIsNestedOpen(true)}>Open child confirmation</Button>
      <Button id="audit-nested-close" onClick={close}>Close parent</Button>
    </Modal>
    <ConfirmDialog className="audit-nested-confirm" title="Child confirmation" isOpen={kind === 'nested' && isNestedOpen}
      confirmIsDestructive confirmHandler={() => overlayEvents.push({ nestedConfirmed: true })}
      onClose={() => setIsNestedOpen(false)} />
    <Modal className="audit-more-modal" title="Owned more-menu fixture" isOpen={kind === 'menu-div' || kind === 'menu-native'}
      isNativeDialog={kind === 'menu-native'} onClose={close} onEnter={() => overlayEvents.push({ modalEnter: true })} isSlim hasCloseButton moreMenuItems={<>
        <MenuItem className="audit-menu-first" onClick={() => overlayEvents.push({ menuAction: 1 })}>First synthetic action</MenuItem>
        <MenuItem className="audit-menu-disabled" disabled onClick={() => overlayEvents.push({ disabledMenuAction: true })}>Disabled synthetic action</MenuItem>
        <MenuItem className="audit-menu-last" onClick={() => overlayEvents.push({ menuAction: 2 })}>Last synthetic action</MenuItem>
      </>}>
      <InputText id="audit-menu-input" value="Modal input" label="Synthetic input" />
      <Button id="audit-menu-close" onClick={close}>Close synthetic modal</Button>
    </Modal>
    {kind === 'delete-photo' && <DeleteProfilePhotoModal isOpen photo={{ mediaType: 'photo', id: '900000002', date: 1790888400, sizes: [] }} profileId="1"
      onConfirm={() => overlayEvents.push({ deletePhotoConfirm: true })} onClose={close} />}
    {kind === 'guard-bot' && <GuardReplaceBotModal isOpen
      currentBot={{ id: '900000003', type: 'userTypeBot', isMin: false, firstName: 'Current synthetic guard', phoneNumber: '' }}
      newBot={{ id: '900000004', type: 'userTypeBot', isMin: false, firstName: 'New synthetic guard', phoneNumber: '' }}
      onConfirm={() => overlayEvents.push({ guardConfirm: true })} onClose={close} />}
    {kind === 'calendar-repeat' && <CalendarModal isOpen selectedAt={1790938800000} withTimePicker withRepeatMode
      submitButtonLabel="Synthetic schedule" onSubmit={(_date, repeatMode) => overlayEvents.push({ calendarSubmit: repeatMode || 'never' })} onClose={close} />}
    <Modal className="audit-button-modal" title="Native button activation" isOpen={kind === 'button-baseline'} onClose={close} isSlim hasCloseButton>
      <Button id="audit-default-button" onClick={() => overlayEvents.push({ defaultButton: true })}>Default desktop button</Button>
      <Button id="audit-default-disabled" disabled onClick={() => overlayEvents.push({ disabledDefaultButton: true })}>Disabled desktop button</Button>
    </Modal>
    {(kind === 'ai-portal-div' || kind === 'ai-portal-native' || kind === 'ai-portal-two') && <Modal className="audit-ai-modal" title="Actual translation editor portal" isOpen
      isNativeDialog={kind === 'ai-portal-native'} hasCloseButton onClose={close} onEnter={() => overlayEvents.push({ aiModalEnter: true })}>
      <AiTextTranslateEditor text={{ text: 'Synthetic English text for isolated translation controls.' }} selectedLanguage="en" isPremium />
    </Modal>}
    {kind === 'ai-portal-two' && isSecondAiOpen && <Modal className="audit-ai-second" title="Second actual translation editor" isOpen isNativeDialog hasCloseButton
      onClose={() => setIsSecondAiOpen(false)} onEnter={() => overlayEvents.push({ aiSecondEnter: true })}>
      <AiTextTranslateEditor text={{ text: 'Second synthetic English text.' }} selectedLanguage="de" isPremium />
    </Modal>}
    {kind === 'ai-external' && <div id="audit-ai-outside" style="position:fixed;top:150px;left:600px;width:500px;z-index:1000">
      <AiTextTranslateEditor text={{ text: 'Outside modal synthetic English text.' }} selectedLanguage="en" isPremium />
    </div>}
    <Modal className="audit-delegation-modal" title="Owned native controls" isOpen={kind === 'enter-delegation'} onClose={close} hasCloseButton
      onEnter={() => overlayEvents.push({ delegationModalEnter: true })}>
      <TextArea id="audit-owned-textarea" noReplaceNewlines value={bio} onChange={(event) => setBio(event.target.value)} label="Owned multiline" />
      <InputText id="audit-owned-input" value={name} onChange={(event) => setName(event.target.value)} label="Owned single line" />
      <div id="audit-owned-contenteditable" contentEditable tabIndex={0}>Owned editable text</div>
      <select id="audit-owned-select"><option value="first">First synthetic option</option><option value="second">Second synthetic option</option></select>
      <input id="audit-owned-radio" type="radio" name="audit-radio" />
      <a href="#audit-owned-link" id="audit-owned-link" onClick={(event) => { event.preventDefault(); overlayEvents.push({ ownedLink: true }); }}>Owned link</a>
    </Modal>
    {kind === 'media' && <div id="audit-media-overlays" style="position:fixed;bottom:1rem;right:1rem;display:flex;gap:0.5rem;z-index:1000">
      {[
        { id: 'media-no-footer', classes: 'message-content media no-footer has-solid-background' },
        { id: 'custom-shape', classes: 'message-content custom-shape no-footer' },
        { id: 'invoice-photo', classes: 'message-content invoice has-photo has-solid-background no-footer' },
      ].map(({ id, classes }) => [false, true].map((isOwn) => <div className={isOwn ? 'Message own' : 'Message'} data-overlay-variant={id}>
        <div className={classes} style="position:relative;width:130px;height:95px">
          <div className="content-inner" style="width:130px;height:95px;background:linear-gradient(135deg,#eee,#292929)">
            <MessageMeta message={Object.values(getGlobal().messages.byChatId['101'].byId).find((message) => Boolean(message.isOutgoing) === isOwn)!}
              isMessagePrimaryEditedDateEnabled={false} onClick={() => undefined} onTranslationClick={() => undefined}
              onEffectClick={() => undefined} onOpenThread={() => undefined} />
          </div>
        </div>
      </div>))}
    </div>}
    <FormattedDateModal isOpen={kind === 'date'} initialDate={1790888400} onClose={close}
      onSubmit={(text) => overlayEvents.push({ date: text })} />
  </>;
};
const overlayRoot = document.createElement('div');
overlayRoot.id = 'relay-ui-audit-overlays';
document.body.append(overlayRoot);
requestMutation(() => TeactDOM.render(<AuditOverlays />, overlayRoot));


import { registerGroups } from './relay-ui-audit.group-state';
registerGroups();

