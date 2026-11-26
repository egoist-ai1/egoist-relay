import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';

import type { AppId } from '../multi/AppSidebar';

import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_MAC_OS } from '../../util/browser/windowEnvironment';
import buildClassName from '../../util/buildClassName';
import captureEscKeyListener from '../../util/captureEscKeyListener';
import { handleError } from '../../util/handleError';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import BrandMark from './BrandMark';
import Icon from './icons/Icon';

import styles from './Titlebar.module.scss';

export type SocialNavigationAction = 'back' | 'forward' | 'home' | 'reload' | 'browser-login';
type OwnProps = {
  activeApp: AppId;
  isMenuAllowed?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isNavigating?: boolean;
  notice?: string;
  isOperationsOpen?: boolean;
  isPaletteOpen?: boolean;
  operationCount?: number;
  onToggleOperations?: NoneToVoidFunction;
  onTogglePalette?: NoneToVoidFunction;
  onMenuVisibilityChange?: (isOpen: boolean) => Promise<boolean>;
  onNavigate: (action: SocialNavigationAction) => void;
};

const Titlebar = ({
  activeApp,
  isMenuAllowed = true,
  canGoBack,
  canGoForward,
  isNavigating,
  notice,
  isOperationsOpen,
  isPaletteOpen,
  operationCount,
  onToggleOperations,
  onTogglePalette,
  onMenuVisibilityChange,
  onNavigate,
}: OwnProps) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const refreshWindowStateRef = useRef<NoneToVoidFunction>();
  const lang = useLang();
  const menuNavigation = isMenuAllowed && activeApp !== 'telegram' ? [
    { action: 'back', label: lang('RelayNavBack'), icon: 'arrow-left', disabled: !canGoBack },
    { action: 'forward', label: lang('RelayNavForward'), icon: 'arrow-right', disabled: !canGoForward },
    { action: 'reload', label: lang('RelayNavReload'), icon: 'reload', disabled: false },
    { action: 'home', label: lang('RelayNavHome'), icon: 'web', disabled: false },
    { action: 'browser-login', label: lang('RelayBrowserLogin'), icon: 'link', disabled: false },
  ] as const : [];

  useEffect(() => {
    if (IS_MAC_OS || !IS_TAURI) return undefined;

    let isMounted = true;
    let unlistenResize: NoneToVoidFunction | undefined;

    async function initWindowState() {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        if (!isMounted) return;

        let isReading = false;
        let needsRead = false;
        async function readWindowState() {
          if (!isMounted) return;
          needsRead = true;
          if (isReading) return;

          isReading = true;
          while (isMounted && needsRead) {
            needsRead = false;
            try {
              const maximized = await currentWindow.isMaximized();
              if (isMounted && !needsRead) setIsMaximized(maximized);
            } catch (err) {
              if (isMounted) handleError(new Error('Failed to read window state', { cause: err }));
            }
          }
          isReading = false;
        }

        const refresh = () => {
          void readWindowState();
        };
        refreshWindowStateRef.current = refresh;
        const releaseResize = await currentWindow.onResized(refresh);
        if (!isMounted) {
          releaseResize();
          return;
        }
        unlistenResize = releaseResize;
        refresh();
      } catch (err) {
        if (isMounted) {
          handleError(new Error('Failed to watch window state', { cause: err }));
          refreshWindowStateRef.current?.();
        }
      }
    }

    void initWindowState();

    return () => {
      isMounted = false;
      refreshWindowStateRef.current = undefined;
      unlistenResize?.();
    };
  }, []);

  const handleMinimize = useLastCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch (err) {
      handleError(new Error('Failed to minimize window', { cause: err }));
    }
  });

  const handleToggleMaximize = useLastCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow();
      await currentWindow.toggleMaximize();
      refreshWindowStateRef.current?.();
    } catch (err) {
      handleError(new Error('Failed to toggle maximize', { cause: err }));
    }
  });

  const handleClose = useLastCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch (err) {
      handleError(new Error('Failed to close window', { cause: err }));
    }
  });

  if (IS_MAC_OS || !IS_TAURI) return undefined;

  return (
    <div
      className={styles.titlebar}
      role="banner"
      data-relay-caption
    >
      <div className={styles.dragRegion} data-tauri-drag-region>
        <span className={styles.brand} data-tauri-drag-region>
          <BrandMark size={20} className={styles.brandMark} isCompact />
          <span className={styles.brandName} data-tauri-drag-region>{lang('RelayBrand')}</span>
        </span>
        <span className={styles.appTitle} data-tauri-drag-region>
          {activeApp === 'x'
            ? lang('RelayXTitle')
            : activeApp === 'instagram'
              ? lang('RelayInstagramTitle')
              : lang('RelayTelegramTitle')}
        </span>
      </div>

      {notice && <span className={styles.notice} title={notice} role="status" aria-live="polite">{notice}</span>}

      {onTogglePalette && (
        <button
          type="button"
          className={buildClassName(styles.operationsButton, isPaletteOpen && styles.operationsOpen)}
          onClick={onTogglePalette}
          aria-label={lang('RelayPaletteTitle')}
          aria-haspopup="dialog"
          aria-expanded={Boolean(isPaletteOpen)}
          aria-keyshortcuts="Control+K"
          title={`${lang('RelayPaletteTitle')} (Ctrl+K)`}
        >
          <Icon name="search" className={styles.navigationIcon} />
        </button>
      )}

      {onToggleOperations && (
        <button
          type="button"
          className={buildClassName(styles.operationsButton, isOperationsOpen && styles.operationsOpen)}
          onClick={onToggleOperations}
          aria-label={lang('RelayOperationTitle')}
          aria-expanded={Boolean(isOperationsOpen)}
          aria-controls="relay-media-operations"
          aria-keyshortcuts="Control+J"
          title={`${lang('RelayOperationTitle')} (Ctrl+J)`}
          data-relay-operations-toggle="true"
        >
          <Icon name="download" className={styles.navigationIcon} />
          {Boolean(operationCount) && <span className={styles.operationCount}>{operationCount}</span>}
        </button>
      )}
      {menuNavigation.length > 0 && (
        <TitlebarActions
          key={activeApp}
          label={lang('RelayServiceActions')}
          onVisibilityChange={onMenuVisibilityChange}
        >
          {(close) => menuNavigation.map(({ action, label, icon, disabled }) => (
            <button
              key={action}
              type="button"
              className={styles.menuAction}
              onClick={() => close(true, () => onNavigate(action))}
              disabled={disabled || isNavigating}
            >
              <Icon name={icon} className={styles.navigationIcon} />
              {label}
            </button>
          ))}
        </TitlebarActions>
      )}
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.button}
          onClick={handleMinimize}
          title={lang('RelayMinimize')}
          aria-label={lang('RelayMinimize')}
        >
          <svg
            viewBox="0 0 12 12"
            className={styles.buttonIcon}
            aria-hidden="true"
            focusable="false"
          >
            <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
        </button>

        <button
          type="button"
          className={styles.button}
          onClick={handleToggleMaximize}
          title={isMaximized ? lang('RelayRestore') : lang('RelayMaximize')}
          aria-label={isMaximized ? lang('RelayRestore') : lang('RelayMaximize')}
        >
          {isMaximized ? (
            <svg
              viewBox="0 0 12 12"
              className={styles.buttonIcon}
              aria-hidden="true"
              focusable="false"
            >
              <rect x="3.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.1" />
              <polyline points="1.5,3.5 1.5,10.5 8.5,10.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 12 12"
              className={styles.buttonIcon}
              aria-hidden="true"
              focusable="false"
            >
              <rect x="1.75" y="1.75" width="8.5" height="8.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className={buildClassName(styles.button, styles.close)}
          onClick={handleClose}
          title={lang('RelayWindowHideToTray')}
          aria-label={lang('RelayWindowHideToTray')}
        >
          <svg
            viewBox="0 0 12 12"
            className={styles.buttonIcon}
            aria-hidden="true"
            focusable="false"
          >
            <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
};

type ActionsProps = {
  label: string;
  onVisibilityChange?: (isOpen: boolean) => Promise<boolean>;
  children: (close: CloseActions) => React.ReactNode;
};

type CloseActions = (shouldRestoreFocus?: boolean, onClosed?: NoneToVoidFunction) => void;
const TITLEBAR_ACTIONS_ID = 'relay-titlebar-actions';

function TitlebarActions({ label, onVisibilityChange, children }: ActionsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>();
  const triggerRef = useRef<HTMLButtonElement>();
  const requestRef = useRef<symbol>();
  const afterCloseRef = useRef<NoneToVoidFunction>();
  const isMountedRef = useRef(true);

  const releaseNativeSurface = useLastCallback(async () => {
    if (!requestRef.current) return false;
    requestRef.current = undefined;
    try {
      return (await onVisibilityChange?.(false)) !== false;
    } catch (err) {
      handleError(new Error('Failed to release titlebar actions', { cause: err }));
      return false;
    }
  });

  const close = useLastCallback<CloseActions>((shouldRestoreFocus, onClosed) => {
    afterCloseRef.current = onClosed;
    setIsOpen(false);
    if (shouldRestoreFocus) triggerRef.current?.focus({ preventScroll: true });
  });

  const handleToggle = useLastCallback(async () => {
    if (isOpen) {
      close(true);
      return;
    }
    if (requestRef.current) return;
    const request = Symbol();
    requestRef.current = request;
    try {
      const canOpen = await onVisibilityChange?.(true);
      if (requestRef.current !== request) return;
      if (canOpen === false) {
        void releaseNativeSurface();
        return;
      }
      setIsOpen(true);
    } catch (err) {
      if (requestRef.current === request) void releaseNativeSurface();
      handleError(new Error('Failed to open titlebar actions', { cause: err }));
    }
  });

  useEffect(() => () => {
    isMountedRef.current = false;
    afterCloseRef.current = undefined;
    void releaseNativeSurface();
  }, [releaseNativeSurface]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const releaseEscape = captureEscKeyListener(() => close(true));
    const handleOutside = (event: Event) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('focusin', handleOutside);
    return () => {
      releaseEscape();
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('focusin', handleOutside);
      const onClosed = afterCloseRef.current;
      afterCloseRef.current = undefined;
      // Навигация доступна после снятия покрытия нативной вкладки
      void releaseNativeSurface().then((didRelease) => {
        if (didRelease && isMountedRef.current && !requestRef.current) onClosed?.();
      });
    };
  }, [isOpen, close, releaseNativeSurface]);

  return (
    <div className={styles.moreActions} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={buildClassName(styles.operationsButton, isOpen && styles.operationsOpen)}
        title={label}
        aria-label={label}
        aria-expanded={isOpen}
        aria-controls={isOpen ? TITLEBAR_ACTIONS_ID : undefined}
        onClick={handleToggle}
      >
        <Icon name="more" className={styles.navigationIcon} />
      </button>
      {isOpen && (
        <div id={TITLEBAR_ACTIONS_ID} className={styles.moreMenu} role="group" aria-label={label}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

export default memo(Titlebar);
