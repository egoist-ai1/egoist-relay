import type { FC } from '../../../lib/teact/teact';
import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { FolderEditDispatch } from '../../../hooks/reducers/useFoldersReducer';
import type { TauriUpdate, TauriUpdateProgress } from '../../../types/tauri';
import { LeftColumnContent } from '../../../types';

import { DEBUG } from '../../../config';
import { selectCommunityPanelId } from '../../../global/selectors';
import { IS_TAURI } from '../../../util/browser/globalEnvironment';
import { IS_TOUCH_ENV } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';

import useSelector from '../../../hooks/data/useSelector';
import useForumPanelRender from '../../../hooks/useForumPanelRender';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';
import useShowTransitionDeprecated from '../../../hooks/useShowTransitionDeprecated';

import Button from '../../ui/Button';
import Transition from '../../ui/Transition';
import NewChatButton from '../NewChatButton';
import LeftSearch from '../search/LeftSearch.async';
import ChatFolders from './ChatFolders';
import CommunityPanel from './community/CommunityPanel';
import ContactList from './ContactList.async';
import ForumPanel from './forum/ForumPanel';
import LeftMainHeader from './LeftMainHeader';

import './LeftMain.scss';

type OwnProps = {
  content: LeftColumnContent;
  searchQuery?: string;
  searchDate?: number;
  contactsFilter: string;
  shouldSkipTransition?: boolean;
  foldersDispatch: FolderEditDispatch;
  isAppUpdateAvailable?: boolean;
  isForumPanelOpen?: boolean;
  isClosingSearch?: boolean;
  onSearchQuery: (query: string) => void;
  onTopicSearch: NoneToVoidFunction;
  isAccountFrozen?: boolean;
  onReset: () => void;
  isFoldersSidebarShown?: boolean;
};

const TRANSITION_RENDER_COUNT = Object.keys(LeftColumnContent).length / 2;
const BUTTON_CLOSE_DELAY_MS = 250;
const TAURI_UPDATE_NOTICE_DURATION_MS = 12000;

function getUpdateErrorText(error: unknown) {
  const text = error instanceof Error ? error.message : (typeof error === 'string' ? error : '');
  return text.trim() || 'Неизвестная ошибка.';
}

function getUpdateButtonText(update: TauriUpdate, progress?: TauriUpdateProgress) {
  if (progress?.phase === 'downloading') {
    const percent = progress.total ? Math.min(100, Math.floor((progress.done / progress.total) * 100)) : 0;
    return `Скачивание ${percent}%`;
  }
  if (progress?.phase === 'verifying') return 'Проверка обновления…';
  if (progress?.phase === 'launching') return 'Запуск установщика…';
  return `Обновить Бересту до ${update.version}${
    update.size ? ` (${Math.round(update.size / (1024 * 1024))} МБ)` : ''}`;
}

let closeTimeout: number | undefined;

const LeftMain: FC<OwnProps> = ({
  content,
  searchQuery,
  searchDate,
  isClosingSearch,
  contactsFilter,
  shouldSkipTransition,
  foldersDispatch,
  isAppUpdateAvailable,
  isForumPanelOpen,
  onSearchQuery,
  onReset,
  onTopicSearch,
  isAccountFrozen,
  isFoldersSidebarShown,
}) => {
  const { openLeftColumnContent, showNotification } = getActions();
  const [isNewChatButtonShown, setIsNewChatButtonShown] = useState(IS_TOUCH_ENV);
  const [tauriUpdate, setTauriUpdate] = useState<TauriUpdate>();
  const [isTauriUpdateDownloading, setIsTauriUpdateDownloading] = useState(false);
  const [tauriUpdateProgress, setTauriUpdateProgress] = useState<TauriUpdateProgress>();

  const {
    shouldRenderForumPanel, handleForumPanelAnimationEnd,
    handleForumPanelAnimationStart, isAnimationStarted,
  } = useForumPanelRender(isForumPanelOpen);
  const isForumPanelRendered = isForumPanelOpen && content === LeftColumnContent.ChatList;
  const isForumPanelVisible = isForumPanelRendered && isAnimationStarted;

  const communityPanelId = useSelector((global) => selectCommunityPanelId(global));
  const isCommunityPanelOpen = Boolean(communityPanelId);
  const {
    shouldRenderForumPanel: shouldRenderCommunityPanel,
    handleForumPanelAnimationEnd: handleCommunityPanelAnimationEnd,
    handleForumPanelAnimationStart: handleCommunityPanelAnimationStart,
  } = useForumPanelRender(isCommunityPanelOpen);
  const isCommunityPanelRendered = isCommunityPanelOpen && content === LeftColumnContent.ChatList;

  const hasUpdate = IS_TAURI ? Boolean(tauriUpdate) : isAppUpdateAvailable;
  const {
    shouldRender: shouldRenderUpdateButton,
    transitionClassNames: updateButtonClassNames,
  } = useShowTransitionDeprecated(hasUpdate);

  const isMouseInsideRef = useRef(false);

  const handleMouseEnter = useLastCallback(() => {
    if (content !== LeftColumnContent.ChatList) {
      return;
    }
    isMouseInsideRef.current = true;
    setIsNewChatButtonShown(true);
  });

  const handleMouseLeave = useLastCallback(() => {
    isMouseInsideRef.current = false;

    if (closeTimeout) {
      clearTimeout(closeTimeout);
      closeTimeout = undefined;
    }

    closeTimeout = window.setTimeout(() => {
      if (!isMouseInsideRef.current) {
        setIsNewChatButtonShown(false);
      }
    }, BUTTON_CLOSE_DELAY_MS);
  });

  const handleSelectContacts = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.Contacts });
  });

  const handleUpdateClick = useLastCallback(async () => {
    if (tauriUpdate) {
      try {
        setIsTauriUpdateDownloading(true);
        setTauriUpdateProgress(undefined);
        // Установщик запускает новую версию сам, а приложение закрывается: relaunch старой не нужен
        await tauriUpdate.downloadAndInstall(setTauriUpdateProgress);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Failed to download and install Tauri update', e);
        showNotification({
          message: `Не удалось обновить Бересту. ${getUpdateErrorText(e)}`,
          duration: TAURI_UPDATE_NOTICE_DURATION_MS,
        });
      } finally {
        setIsTauriUpdateDownloading(false);
        setTauriUpdateProgress(undefined);
      }
    } else {
      window.location.reload();
    }
  });

  const handleSelectNewChannel = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.NewChannelStep1 });
  });

  const handleSelectNewGroup = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.NewGroupStep1 });
  });

  useEffect(() => {
    let autoCloseTimeout: number | undefined;
    if (content !== LeftColumnContent.ChatList) {
      autoCloseTimeout = window.setTimeout(() => {
        setIsNewChatButtonShown(false);
      }, BUTTON_CLOSE_DELAY_MS);
    } else if (isMouseInsideRef.current || IS_TOUCH_ENV) {
      setIsNewChatButtonShown(true);
    }

    return () => {
      if (autoCloseTimeout) {
        clearTimeout(autoCloseTimeout);
        autoCloseTimeout = undefined;
      }
    };
  }, [content]);

  const checkTauriUpdate = useLastCallback(() => {
    window.tauri?.checkUpdate()
      .then((update) => setTauriUpdate(update ?? undefined))
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('Tauri update check failed:', e);
      });
  });

  // Периодическую проверку ведёт бэкенд (раз в 6 часов, событие `update-available`); здесь одна проверка при
  // запуске, и она отвечает из кэша бэкенда. В режиме `off` автоматически ничего не проверяется.
  useEffect(() => {
    if (!IS_TAURI || DEBUG || !window.tauri?.getUpdateMode) return undefined;
    let isActive = true;
    let release: (() => void) | undefined;

    const notify = (message: string) => showNotification({ message, duration: TAURI_UPDATE_NOTICE_DURATION_MS });

    (async () => {
      const mode = await window.tauri.getUpdateMode();
      if (!isActive || mode === 'off') return;
      const stopListening = await window.tauri.onUpdateEvents({
        onAvailable: () => {
          if (isActive) checkTauriUpdate();
        },
        onManual: ({ message }) => notify(
          `${message} Обновите вручную: скачайте новый установщик Бересты.`,
        ),
        onFailed: ({ message }) => notify(message),
      });
      if (isActive) release = stopListening;
      else stopListening();
      checkTauriUpdate();
    })().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('Tauri update setup failed:', e);
    });

    return () => {
      isActive = false;
      release?.();
    };
  }, []);

  const lang = useOldLang();

  return (
    <div
      id="LeftColumn-main"
      onMouseEnter={!IS_TOUCH_ENV ? handleMouseEnter : undefined}
      onMouseLeave={!IS_TOUCH_ENV ? handleMouseLeave : undefined}
    >
      <LeftMainHeader
        shouldHideSearch={isForumPanelVisible}
        content={content}
        contactsFilter={contactsFilter}
        onSearchQuery={onSearchQuery}
        onReset={onReset}
        shouldSkipTransition={shouldSkipTransition}
        isClosingSearch={isClosingSearch}
        isFoldersSidebarShown={isFoldersSidebarShown}
      />
      <Transition
        name={shouldSkipTransition ? 'none' : 'zoomFade'}
        renderCount={TRANSITION_RENDER_COUNT}
        activeKey={content}
        shouldCleanup
        cleanupExceptionKey={LeftColumnContent.ChatList}
        shouldWrap
        wrapExceptionKey={LeftColumnContent.ChatList}
      >
        {(isActive) => {
          switch (content) {
            case LeftColumnContent.ChatList:
              return (
                <ChatFolders
                  foldersDispatch={foldersDispatch}
                  isForumPanelOpen={isForumPanelVisible}
                  isFoldersSidebarShown={isFoldersSidebarShown}
                />
              );
            case LeftColumnContent.GlobalSearch:
              return (
                <LeftSearch
                  searchQuery={searchQuery}
                  searchDate={searchDate}
                  isActive={isActive}
                  onReset={onReset}
                />
              );
            case LeftColumnContent.Contacts:
              return <ContactList filter={contactsFilter} isActive={isActive} onReset={onReset} />;
            default:
              return undefined;
          }
        }}
      </Transition>
      {shouldRenderUpdateButton && (
        <Button
          fluid
          badge
          className={buildClassName('btn-update', updateButtonClassNames)}
          onClick={handleUpdateClick}
          disabled={isTauriUpdateDownloading}
        >
          {tauriUpdate
            ? getUpdateButtonText(tauriUpdate, isTauriUpdateDownloading ? tauriUpdateProgress : undefined)
            : lang('lng_update_telegram')}
        </Button>
      )}
      {shouldRenderCommunityPanel && (
        <CommunityPanel
          isOpen={isCommunityPanelOpen}
          isHidden={!isCommunityPanelRendered}
          onOpenAnimationStart={handleCommunityPanelAnimationStart}
          onCloseAnimationEnd={handleCommunityPanelAnimationEnd}
        />
      )}
      {shouldRenderForumPanel && (
        <ForumPanel
          isOpen={isForumPanelOpen}
          isHidden={!isForumPanelRendered}
          onTopicSearch={onTopicSearch}
          onOpenAnimationStart={handleForumPanelAnimationStart}
          onCloseAnimationEnd={handleForumPanelAnimationEnd}
        />
      )}
      <NewChatButton
        isShown={isNewChatButtonShown}
        onNewPrivateChat={handleSelectContacts}
        onNewChannel={handleSelectNewChannel}
        onNewGroup={handleSelectNewGroup}
        isAccountFrozen={isAccountFrozen}
      />
    </div>
  );
};

export default memo(LeftMain);
