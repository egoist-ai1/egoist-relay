import { memo, useEffect, useState } from '../../lib/teact/teact';

import type { AppId } from '../multi/AppSidebar';

import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_MAC_OS } from '../../util/browser/windowEnvironment';
import buildClassName from '../../util/buildClassName';
import { handleError } from '../../util/handleError';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from './icons/Icon';

import styles from './Titlebar.module.scss';

export type SocialNavigationAction = 'back' | 'forward' | 'home' | 'reload';
type OwnProps = {
  activeApp: AppId;
  isXAuthRequired?: boolean;
  canNavigate?: boolean;
  isNavigating?: boolean;
  notice?: string;
  onLoginX: NoneToVoidFunction;
  onNavigate: (action: SocialNavigationAction) => void;
};

const Titlebar = ({
  activeApp,
  isXAuthRequired,
  canNavigate,
  isNavigating,
  notice,
  onLoginX,
  onNavigate,
}: OwnProps) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const lang = useLang();
  const handleBack = useLastCallback(() => onNavigate('back'));
  const handleForward = useLastCallback(() => onNavigate('forward'));
  const handleHome = useLastCallback(() => onNavigate('home'));
  const handleReload = useLastCallback(() => onNavigate('reload'));

  useEffect(() => {
    if (IS_MAC_OS || !IS_TAURI) return undefined;

    let isMounted = true;
    let unlistenResize: NoneToVoidFunction | undefined;

    async function initWindowState() {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        if (!isMounted) return;

        const initialMaximized = await currentWindow.isMaximized();
        if (!isMounted) return;
        setIsMaximized(initialMaximized);
        const releaseResize = await currentWindow.onResized(async () => {
          if (!isMounted) return;
          try {
            const maximized = await currentWindow.isMaximized();
            if (isMounted) setIsMaximized(maximized);
          } catch (err) {
            if (isMounted) handleError(new Error('Failed to read resized window state', { cause: err }));
          }
        });
        if (!isMounted) {
          releaseResize();
          return;
        }
        unlistenResize = releaseResize;
      } catch (err) {
        handleError(new Error('Failed to read window state', { cause: err }));
      }
    }

    void initWindowState();

    return () => {
      isMounted = false;
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
      setIsMaximized(await currentWindow.isMaximized());
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
    >
      <div className={styles.dragRegion} data-tauri-drag-region>
        <span className={styles.appTitle}>
          {activeApp === 'x'
            ? lang('RelayXTitle')
            : activeApp === 'instagram'
              ? lang('RelayInstagramTitle')
              : lang('RelayTelegramTitle')}
        </span>
      </div>

      {notice && <span className={styles.notice} title={notice} role="status" aria-live="polite">{notice}</span>}

      {activeApp !== 'telegram' && (
        <div className={styles.navigation} role="group" aria-label={lang('RelayNavigation')}>
          <button
            type="button"
            className={styles.navigationButton}
            onClick={handleBack}
            disabled={!canNavigate || isNavigating}
            title={lang('RelayNavBack')}
            aria-label={lang('RelayNavBack')}
          >
            <Icon name="arrow-left" className={styles.navigationIcon} />
          </button>
          <button
            type="button"
            className={styles.navigationButton}
            onClick={handleForward}
            disabled={!canNavigate || isNavigating}
            title={lang('RelayNavForward')}
            aria-label={lang('RelayNavForward')}
          >
            <Icon name="arrow-right" className={styles.navigationIcon} />
          </button>
          <button
            type="button"
            className={styles.navigationButton}
            onClick={handleHome}
            disabled={isNavigating}
            title={lang('RelayNavHome')}
            aria-label={lang('RelayNavHome')}
          >
            <svg viewBox="0 0 24 24" className={styles.homeIcon} aria-hidden="true" focusable="false">
              <path d="M3 10.5 12 3l9 7.5M5 9v12h5v-7h4v7h5V9" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.navigationButton}
            onClick={handleReload}
            disabled={isNavigating}
            title={lang('RelayNavReload')}
            aria-label={lang('RelayNavReload')}
          >
            <Icon name="reload" className={styles.navigationIcon} />
          </button>
        </div>
      )}

      {activeApp === 'x' && isXAuthRequired && (
        <button
          type="button"
          className={styles.loginButton}
          title={lang('RelayXDirectLogin')}
          aria-label={lang('RelayXDirectLogin')}
          onClick={onLoginX}
        >
          <span className={styles.loginLabel} aria-hidden="true">{lang('RelayXDirectLogin')}</span>
          <span className={styles.loginShortLabel} aria-hidden="true">{lang('RelayLoginShort')}</span>
        </button>
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
          title={lang('Close')}
          aria-label={lang('Close')}
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

export default memo(Titlebar);
