import type { TeactNode } from '../../lib/teact/teact';
import { memo, useRef } from '../../lib/teact/teact';

import type { RegularLangKey } from '../../types/language';
import type { NetworkServiceRoute } from '../../util/tauri/relayNetwork';

import buildClassName from '../../util/buildClassName';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import styles from './AppSidebar.module.scss';

export type AppId = 'telegram' | 'x' | 'instagram';
export type XAppState = 'idle' | 'loading' | 'ready' | 'error' | 'auth-required';
export type InstagramAppState = 'idle' | 'loading' | 'ready' | 'error';

type ServiceState = XAppState | InstagramAppState;

type OwnProps = {
  activeApp: AppId;
  xAppState: XAppState;
  instagramAppState?: InstagramAppState;
  // Сервисы, чей WebView усыплён оболочкой (скрыт и приостановлен)
  sleepingApps?: AppId[];
  // Скрытые сервисы не показываются в rail; Telegram скрыть нельзя
  hiddenApps?: AppId[];
  // Маршрут сервиса из статуса сети: недоступный помечается ошибкой, прямой отмечен только в подписи
  networkRoutes?: Record<AppId, NetworkServiceRoute>;
  onSelectApp: (app: AppId) => void;
  // Настройки приложения (сервисы, сеть): кнопка внизу rail
  onOpenSettings?: NoneToVoidFunction;
};

type ServiceDef = {
  id: AppId;
  service: string;
  titleKey: RegularLangKey;
  switchKey: RegularLangKey;
  loadingKey?: RegularLangKey;
  errorKey?: RegularLangKey;
  authKey?: RegularLangKey;
  icon: TeactNode;
};

const SERVICES: ServiceDef[] = [
  {
    id: 'telegram',
    service: 'main',
    titleKey: 'RelayTelegramTitle',
    switchKey: 'RelaySwitchTelegram',
    icon: (
      <svg viewBox="18 32 76 64" className={styles.serviceSvg} aria-hidden="true" focusable="false">
        <path
          d="M23.775 58.77a3278.85 3278.85 0 0 1 39.27-16.223c18.698-7.454 21.3-8.542 23.828-8.58a4.995 4.995 0 0 1 2.977 1.103c1.058.9 1.38 1.47 1.47 1.972.083.503.075 2.07-.015 2.963-1.013 10.207-4.86 33.78-7.088 45.225-.945 4.837-2.805 6.457-4.605 6.615-3.907.345-6.877-2.475-10.664-4.86-5.925-3.728-7.905-5.1-13.65-8.737-6.653-4.2-3.916-5.663-.128-9.436.99-.982 17.415-15.974 17.662-17.34.21-1.2.286-1.357-.254-1.897-.548-.54-1.2-.473-1.62-.383-.6.128-9.645 5.85-27.15 17.176-2.685 1.777-5.115 2.64-7.298 2.595-2.4-.053-7.027-1.305-10.462-2.378-4.223-1.32-7.575-2.01-7.275-4.245.15-1.163 1.814-2.355 5.002-3.57Z"
          fill="currentColor"
        />
      </svg>
    ),
  },
  {
    id: 'x',
    service: 'x',
    titleKey: 'RelayXTitle',
    switchKey: 'RelaySwitchX',
    loadingKey: 'RelayXLoadingTitle',
    errorKey: 'RelayXErrorTitle',
    authKey: 'RelayXDirectLoginTitle',
    icon: (
      <svg viewBox="0 0 24 24" className={styles.serviceSvg} fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    id: 'instagram',
    service: 'instagram',
    titleKey: 'RelayInstagramTitle',
    switchKey: 'RelaySwitchInstagram',
    loadingKey: 'RelayInstagramLoadingTitle',
    errorKey: 'RelayInstagramErrorTitle',
    icon: (
      <svg
        viewBox="0 0 24 24"
        className={styles.serviceSvg}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
        <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
        <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" stroke-width="2.5" />
      </svg>
    ),
  },
];

type Indicator = 'loading' | 'error' | 'sleep' | undefined;

function resolveIndicator(state: ServiceState, isSleeping: boolean): Indicator {
  if (state === 'loading') return 'loading';
  if (state === 'error' || state === 'auth-required') return 'error';
  return isSleeping ? 'sleep' : undefined;
}

const AppSidebar = ({
  activeApp,
  xAppState,
  instagramAppState = 'idle',
  sleepingApps,
  hiddenApps,
  networkRoutes,
  onSelectApp,
  onOpenSettings,
}: OwnProps) => {
  const lang = useLang();
  const appListRef = useRef<HTMLDivElement>();

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

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onSelectApp(e.currentTarget.dataset.relayApp as AppId);
  });

  return (
    <nav className={styles.sidebar} aria-label={lang('RelayAppSwitcher')}>
      <div className={styles.dragHeader} data-tauri-drag-region />

      <div ref={appListRef} className={styles.appList} onKeyDown={handleNavigationKey}>
        {SERVICES.filter((def) => def.id === 'telegram' || !hiddenApps?.includes(def.id)).map((def) => {
          const state: ServiceState = def.id === 'x' ? xAppState
            : def.id === 'instagram' ? instagramAppState : 'ready';
          const isActive = activeApp === def.id;
          const route = networkRoutes?.[def.id];
          const isNetworkDown = route === 'unavailable' && state !== 'loading';
          const indicator = isNetworkDown
            ? 'error' : resolveIndicator(state, Boolean(sleepingApps?.includes(def.id)));
          const stateKey = state === 'loading' ? def.loadingKey
            : state === 'error' ? def.errorKey
              : state === 'auth-required' ? def.authKey
                : isNetworkDown ? 'RelayNetRailUnavailable'
                  : route === 'direct' ? 'RelayNetRailDirect'
                    : indicator === 'sleep' ? 'RelayServiceSleeping' : undefined;
          const stateLabel = stateKey ? lang(stateKey) : undefined;
          const switchLabel = lang(def.switchKey);

          return (
            <button
              key={def.id}
              type="button"
              className={buildClassName(
                styles.appButton,
                isActive && styles.active,
                indicator === 'error' && styles.hasError,
                indicator === 'sleep' && styles.sleeping,
              )}
              onClick={handleClick}
              title={stateLabel ? `${lang(def.titleKey)} · ${stateLabel}` : lang(def.titleKey)}
              aria-label={stateLabel ? `${switchLabel}. ${stateLabel}` : switchLabel}
              aria-current={isActive ? 'page' : undefined}
              tabIndex={isActive ? 0 : -1}
              aria-busy={def.id === 'telegram' ? undefined : state === 'loading'}
              aria-controls={`relay-${def.id}-pane`}
              data-relay-app={def.id}
              data-relay-service={def.service}
              data-relay-indicator={indicator}
            >
              <span className={styles.serviceIcon}>
                {def.icon}
                {indicator && (
                  <span
                    className={buildClassName(
                      styles.stateDot,
                      indicator === 'error' && styles.stateDotError,
                      indicator === 'sleep' && styles.stateDotSleep,
                    )}
                    aria-hidden="true"
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>

      {onOpenSettings && (
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.appButton}
            onClick={onOpenSettings}
            title={lang('RelayAppSettingsOpen')}
            aria-label={lang('RelayAppSettingsOpen')}
            aria-haspopup="dialog"
            data-relay-settings
          >
            {/* Шрифтовая иконка напрямую, без компонента Icon: rail не зависит от глобального состояния */}
            <i className={buildClassName('icon icon-settings', styles.footerIcon)} aria-hidden="true" />
          </button>
        </div>
      )}
    </nav>
  );
};

export default memo(AppSidebar);
