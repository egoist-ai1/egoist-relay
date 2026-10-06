import { memo, useRef } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import styles from './AppSidebar.module.scss';

export type AppId = 'telegram' | 'x' | 'instagram';
export type XAppState = 'idle' | 'loading' | 'ready' | 'error' | 'auth-required';
export type InstagramAppState = 'idle' | 'loading' | 'ready' | 'error';

type OwnProps = {
  activeApp: AppId;
  xAppState: XAppState;
  instagramAppState?: InstagramAppState;
  onSelectApp: (app: AppId) => void;
};

const AppSidebar = ({
  activeApp,
  xAppState,
  instagramAppState = 'idle',
  onSelectApp,
}: OwnProps) => {
  const lang = useLang();
  const appListRef = useRef<HTMLDivElement>();
  const xStateLabel = xAppState === 'loading' ? lang('RelayXLoadingTitle')
    : xAppState === 'error' ? lang('RelayXErrorTitle')
      : xAppState === 'auth-required' ? lang('RelayXDirectLoginTitle') : undefined;
  const instagramStateLabel = instagramAppState === 'loading' ? lang('RelayInstagramLoadingTitle')
    : instagramAppState === 'error' ? lang('RelayInstagramErrorTitle') : undefined;

  const handleNavigationKey = useLastCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(appListRef.current!.querySelectorAll<HTMLButtonElement>('[data-relay-app]'));
    const index = buttons.findIndex((button) => button === e.target);
    if (index < 0) return;

    let nextIndex: number;
    switch (e.key) {
      case 'ArrowDown':
        nextIndex = (index + 1) % buttons.length;
        break;
      case 'ArrowUp':
        nextIndex = (index + buttons.length - 1) % buttons.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = buttons.length - 1;
        break;
      default: return;
    }
    e.preventDefault();
    buttons[nextIndex].focus();
  });

  const handleSelectTelegram = useLastCallback(() => {
    onSelectApp('telegram');
  });

  const handleSelectX = useLastCallback(() => {
    onSelectApp('x');
  });

  const handleSelectInstagram = useLastCallback(() => {
    onSelectApp('instagram');
  });

  return (
    <nav className={styles.sidebar} aria-label={lang('RelayAppSwitcher')}>
      <div className={styles.dragHeader} data-tauri-drag-region />

      <div ref={appListRef} className={styles.appList} onKeyDown={handleNavigationKey}>
        <div className={styles.appItem}>
          <button
            type="button"
            className={buildClassName(styles.appButton, activeApp === 'telegram' && styles.active)}
            onClick={handleSelectTelegram}
            title={lang('RelaySwitchTelegram')}
            aria-label={lang('RelaySwitchTelegram')}
            aria-current={activeApp === 'telegram' ? 'page' : undefined}
            aria-pressed={activeApp === 'telegram'}
            aria-controls="relay-telegram-pane"
            data-relay-app="telegram"
            data-relay-service="main"
          >
            <span className={styles.activeIndicator} aria-hidden="true" />
            <span className={styles.serviceIcon}>
              <svg viewBox="18 32 76 64" className={styles.telegramIcon} aria-hidden="true" focusable="false">
                <path
                  d="M23.775 58.77a3278.85 3278.85 0 0 1 39.27-16.223c18.698-7.454 21.3-8.542 23.828-8.58a4.995 4.995 0 0 1 2.977 1.103c1.058.9 1.38 1.47 1.47 1.972.083.503.075 2.07-.015 2.963-1.013 10.207-4.86 33.78-7.088 45.225-.945 4.837-2.805 6.457-4.605 6.615-3.907.345-6.877-2.475-10.664-4.86-5.925-3.728-7.905-5.1-13.65-8.737-6.653-4.2-3.916-5.663-.128-9.436.99-.982 17.415-15.974 17.662-17.34.21-1.2.286-1.357-.254-1.897-.548-.54-1.2-.473-1.62-.383-.6.128-9.645 5.85-27.15 17.176-2.685 1.777-5.115 2.64-7.298 2.595-2.4-.053-7.027-1.305-10.462-2.378-4.223-1.32-7.575-2.01-7.275-4.245.15-1.163 1.814-2.355 5.002-3.57Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <span className={buildClassName(styles.appLabel, activeApp === 'telegram' && styles.activeLabel)}>
              {lang('RelayTelegramTitle')}
            </span>
          </button>
        </div>

        <div className={styles.appItem}>
          <button
            type="button"
            className={buildClassName(
              styles.appButton,
              activeApp === 'x' && styles.active,
              xAppState === 'error' && styles.hasError,
            )}
            onClick={handleSelectX}
            title={xStateLabel ? `${lang('RelaySwitchX')}\n${xStateLabel}` : lang('RelaySwitchX')}
            aria-label={xStateLabel ? `${lang('RelaySwitchX')}. ${xStateLabel}` : lang('RelaySwitchX')}
            aria-current={activeApp === 'x' ? 'page' : undefined}
            aria-pressed={activeApp === 'x'}
            aria-busy={xAppState === 'loading'}
            aria-controls="relay-x-pane"
            data-relay-app="x"
            data-relay-service="x"
          >
            <span className={styles.activeIndicator} aria-hidden="true" />
            <span className={styles.serviceIcon}>
              <svg
                viewBox="0 0 24 24"
                className={styles.xIcon}
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              {(xAppState === 'loading' || xAppState === 'error' || xAppState === 'auth-required') && (
                <span
                  className={buildClassName(styles.stateDot, xAppState !== 'loading' && styles.stateDotError)}
                  aria-hidden="true"
                />
              )}
            </span>
            <span className={buildClassName(styles.appLabel, activeApp === 'x' && styles.activeLabel)}>
              {lang('RelayXTitle')}
            </span>
          </button>
        </div>

        <div className={styles.appItem}>
          <button
            type="button"
            className={buildClassName(
              styles.appButton,
              activeApp === 'instagram' && styles.active,
              instagramAppState === 'error' && styles.hasError,
            )}
            onClick={handleSelectInstagram}
            title={instagramStateLabel
              ? `${lang('RelaySwitchInstagram')}\n${instagramStateLabel}` : lang('RelaySwitchInstagram')}
            aria-label={instagramStateLabel
              ? `${lang('RelaySwitchInstagram')}. ${instagramStateLabel}` : lang('RelaySwitchInstagram')}
            aria-current={activeApp === 'instagram' ? 'page' : undefined}
            aria-pressed={activeApp === 'instagram'}
            aria-busy={instagramAppState === 'loading'}
            aria-controls="relay-instagram-pane"
            data-relay-app="instagram"
            data-relay-service="instagram"
          >
            <span className={styles.activeIndicator} aria-hidden="true" />
            <span className={styles.serviceIcon}>
              <svg
                viewBox="0 0 24 24"
                className={styles.instagramIcon}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" strokeWidth="2.5" />
              </svg>
              {(instagramAppState === 'loading' || instagramAppState === 'error') && (
                <span
                  className={buildClassName(styles.stateDot, instagramAppState === 'error' && styles.stateDotError)}
                  aria-hidden="true"
                />
              )}
            </span>
            <span className={buildClassName(styles.appLabel, activeApp === 'instagram' && styles.activeLabel)}>
              {lang('RelayInstagramTitle')}
            </span>
          </button>
        </div>
      </div>
    </nav>
  );
};

export default memo(AppSidebar);
